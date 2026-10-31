export * as PreviewProcess from "./preview-process"

import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, readdir, open, access } from "node:fs/promises"
import { spawn } from "node:child_process"
import { scheduler } from "node:timers/promises"
import { PreviewNative } from "#preview-native"
import { PreviewWindows } from "./preview-windows"
import { Effect, Schema } from "effect"
import type { ChildProcess } from "effect/unstable/process"

export type Owner = {
  root: string
  jobID: string
  sessionID: string
  directory: string
  workspaceID?: string
}

const Record = Schema.Struct({
  pid: Schema.Int,
  birth: Schema.String,
  sessionID: Schema.String,
  jobID: Schema.String,
  directory: Schema.String,
  workspaceID: Schema.optional(Schema.String),
  started: Schema.Number,
})
type Record = typeof Record.Type

const folder = (owner: Owner) =>
  path.join(owner.root, "preview-processes", createHash("sha256").update(owner.jobID).digest("hex"))
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const psquote = (value: string) => `'${value.replaceAll("'", "''")}'`
const winquote = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`

// The supervisor owns a kill-on-close Windows Job. It is itself created outside
// the caller's Job so normal CLI exit cannot close the service's handles.
// Reflection.Emit binds the OS functions without invoking a compiler or creating
// compiler files in the user's TEMP. All handles stay with the supervisor.

const setup = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; `

export async function birth(pid: number) {
  if (process.platform === "win32") return PreviewNative.windowsProcess(pid)
  if (process.platform !== "linux") throw new Error("Persistent preview ownership is supported on Windows and Linux")
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined)
  if (!stat) return
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  if (fields[0] === "Z") return
  return `${(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}:${fields[19]}`
}

async function load(owner: Owner) {
  const value = await readFile(path.join(folder(owner), "owner.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return
    throw error
  })
  if (!value) return
  const record = Schema.decodeUnknownSync(Schema.fromJsonString(Record))(value)
  if (
    record.sessionID !== owner.sessionID ||
    record.jobID !== owner.jobID ||
    record.directory !== owner.directory ||
    record.workspaceID !== owner.workspaceID
  )
    throw new Error("Preview belongs to another Session or Location")
  return record
}

export async function get(owner: Owner) {
  const record = await load(owner)
  if (!record) return
  const result = await readFile(path.join(folder(owner), "result.json"), "utf8").catch(() => undefined)
  const alive = (await birth(record.pid)) === record.birth
  const exit = result && /^-?\d+\s*$/.test(result) ? Number(result) : undefined
  const cancelled = await access(path.join(folder(owner), "cancelled")).then(
    () => true,
    () => false,
  )
  const log = await open(path.join(folder(owner), "output.log"), "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return
    throw error
  })
  const output = log
    ? await (async () => {
        try {
          const size = (await log.stat()).size
          const bytes = Buffer.alloc(Math.min(size, 32768))
          await log.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length))
          return `${size > bytes.length ? "[Earlier output retained in the owned log]\n" : ""}${bytes.toString("utf8")}`
        } finally {
          await log.close()
        }
      })()
    : ""
  return {
    status: alive
      ? "running"
      : cancelled
        ? "cancelled"
        : exit === 0
          ? "completed"
          : exit !== undefined
            ? "error"
            : "unavailable",
    pid: record.pid,
    birth: record.birth,
    exit,
    output: `Owned preview PID ${record.pid}; birth ${record.birth}. Log: ${path.join(folder(owner), "output.log")}${!alive && exit === undefined && !cancelled ? "\nOwner unavailable; effects are unknown. Never restart automatically." : ""}\n${output}`,
  }
}

/** Native handles or the supervisor's own birth check prevent signalling a reused PID. */
export async function cancel(owner: Owner) {
  const record = await load(owner)
  if (!record || (await birth(record.pid)) !== record.birth) return get(owner)
  if (process.platform === "win32") {
    if (
      (await PreviewNative.windowsProcess(record.pid, record.birth, path.join(folder(owner), "cancelled"))) !==
      record.birth
    )
      return get(owner)
  } else {
    if (
      !(await PreviewNative.cancelLinux(
        record.pid,
        record.birth,
        path.join(folder(owner), "cancel.request"),
        () => birth(record.pid),
        path.join(folder(owner), "cancelled"),
      ))
    )
      return get(owner)
  }
  await writeFile(path.join(folder(owner), "cancelled"), "cancelled", { mode: 0o600, flag: "wx" }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    },
  )
  for (let count = 0; count < 100 && (await birth(record.pid)) === record.birth; count++) await scheduler.wait(20)
  return get(owner)
}

export async function archive(root: string, sessionID: string, directory: string, workspaceID?: string) {
  const base = path.join(root, "preview-processes")
  for (const name of await readdir(base).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })) {
    const raw = await readFile(path.join(base, name, "owner.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (!raw) continue
    const record = Schema.decodeUnknownSync(Schema.fromJsonString(Record))(raw)
    if (record.sessionID === sessionID) await cancel({ root, sessionID, jobID: record.jobID, directory, workspaceID })
  }
}

/** A durable preview exempts an unfinished shell row only while its OS owner is verified. */
export async function live(
  root: string,
  sessionID: string,
  directory: string,
  workspaceID?: string,
  known: ReadonlySet<string> = new Set(),
) {
  const ids = new Set(known)
  const base = path.join(root, "preview-processes")
  for (const name of await readdir(base).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })) {
    const raw = await readFile(path.join(base, name, "owner.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (!raw) continue // A launch has not yet completed durable admission.
    const record = Schema.decodeUnknownSync(Schema.fromJsonString(Record))(raw)
    if (record.sessionID !== sessionID || ids.has(record.jobID)) continue
    if ((await get({ root, sessionID, directory, workspaceID, jobID: record.jobID }))?.status === "running")
      ids.add(record.jobID)
  }
  return ids
}

export const run = (
  command: ChildProcess.StandardCommand,
  owner: Owner,
  timeout?: number,
  onSpawn?: (pid: number) => Effect.Effect<void, unknown>,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const pid = yield* Effect.tryPromise(async () => {
        if (await load(owner))
          throw new Error("Preview has an existing durable owner; query it instead of executing again")
        const dir = folder(owner)
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await writeFile(path.join(dir, "launching"), "Admission in progress; never rerun an unknown launch", {
          flag: "wx",
          mode: 0o600,
        })
        const result = path.join(dir, "result.json")
        const log = path.join(dir, "output.log")
        const ownership = JSON.stringify({
          sessionID: owner.sessionID,
          jobID: owner.jobID,
          directory: owner.directory,
          workspaceID: owner.workspaceID,
          started: Date.now(),
        })
        const temporary = path.join(dir, "owner.tmp")
        const destination = path.join(dir, "owner.json")
        const shell = command.options.shell
        const executable = shell
          ? typeof shell === "string"
            ? shell
            : process.platform === "win32"
              ? (process.env.ComSpec ?? "cmd.exe")
              : "/bin/sh"
          : command.command
        const script = [command.command, ...command.args].join(" ")
        const cmd = process.platform === "win32" && /(?:^|[\\/])cmd(?:\.exe)?$/i.test(executable)
        const args = shell ? (cmd ? ["/d", "/s", "/c", script] : ["-c", script]) : command.args.map(String)
        const env = command.options.extendEnv ? { ...process.env, ...command.options.env } : command.options.env
        const cwd = command.options.cwd ?? owner.directory
        const pid = await (async () => {
          if (process.platform === "win32") {
            // Invoke exactly the selected executable. Encoding applies only to an
            // already selected PowerShell command, never changes the user's shell.
            const argv =
              /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(executable) && args.at(-2)?.toLowerCase() === "-command"
                ? [...args.slice(0, -2), "-EncodedCommand", Buffer.from(args.at(-1)!, "utf16le").toString("base64")]
                : args
            const child =
              shell && cmd
                ? `${winquote(executable)} /d /s /c "${script}"`
                : [executable, ...argv].map(winquote).join(" ")
            const supervisor = path.join(dir, "supervisor.ps1")
            // The prefix is already JSON-encoded; append only OS decimal identities
            // without loading PowerShell's JSON/member cmdlets during cold startup.
            await writeFile(
              supervisor,
              `\uFEFF${setup}${PreviewWindows.script}\n$identity=[string][Diagnostics.Process]::GetCurrentProcess().StartTime.ToFileTimeUtc()\n[IO.File]::WriteAllText(${psquote(temporary)},(${psquote(ownership.slice(0, -1))} + ',"pid":' + $PID + ',"birth":"' + $identity + '"}'),[Text.UTF8Encoding]::new($false))\n[IO.File]::Move(${psquote(temporary)},${psquote(destination)})\n$code=Native-Launch ${psquote(child)} ${psquote(cwd)} $false ${timeout ?? 0} ${psquote(log)}\n[IO.File]::WriteAllText(${psquote(result)},[string]$code)\nexit $code`,
              { mode: 0o600 },
            )
            const line = [
              path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              supervisor,
            ]
              .map(winquote)
              .join(" ")
            return PreviewNative.launchWindows(line, cwd, env)
          }
          if (process.platform !== "linux") throw new Error("Unsupported persistent preview platform")
          const supervisor = path.join(dir, "supervisor.sh")
          await writeFile(
            supervisor,
            `#!/bin/sh
stop_group() {
 trap '' TERM INT
 [ -f ${quote(result)} ] || printf 143 > ${quote(result)}
 kill -TERM -$$ 2>/dev/null
 sleep 0.1
 kill -KILL -$$ 2>/dev/null
}
trap stop_group TERM INT
IFS= read -r boot < /proc/sys/kernel/random/boot_id
IFS= read -r own_stat < /proc/$$/stat
own_fields=\${own_stat##*) }; set -- $own_fields; shift 19
birth="$boot:$1"
check_cancel() {
 [ -f ${quote(path.join(dir, "cancel.request"))} ] || return 0
 IFS= read -r request < ${quote(path.join(dir, "cancel.request"))} || :
 if [ "$request" = "$birth" ]; then
  [ -f ${quote(path.join(dir, "cancelled"))} ] || (set -C; printf cancelled > ${quote(path.join(dir, "cancelled"))}) || return 1
  stop_group
 fi
}
printf '%s,"pid":%s,"birth":"%s:%s"}' ${quote(ownership.slice(0, -1))} "$$" "$boot" "$1" > ${quote(temporary)}
mv ${quote(temporary)} ${quote(destination)} || exit 125
watchdog=0
${timeout === undefined ? "" : `(sleep ${(timeout / 1000).toFixed(3)}; printf 124 > ${quote(result)}; kill -TERM -$$) &\nwatchdog=$!\n`}
${[executable, ...args].map(quote).join(" ")} &
child=$!
while kill -0 "$child" 2>/dev/null; do
 check_cancel
 sleep 0.05
done
wait "$child"
code=$?
# A launching shell may exit after nohup/& while its service remains in this
# owned group. Keep supervision and the original deadline until it ends.
while :; do
 check_cancel
 running=false
 for entry in /proc/[0-9]*/stat; do
  IFS= read -r row < "$entry" 2>/dev/null || continue
  item=\${entry#/proc/}; item=\${item%/stat}
  [ "$item" = "$$" ] && continue
  fields=\${row##*) }; set -- $fields
  [ "$3" = "$$" ] || continue
  [ "$1" = Z ] && continue
  [ "$item" = "$watchdog" ] && continue
  [ "$2" = "$watchdog" ] && continue
  running=true; break
 done
 $running || break
 sleep 0.1
done
printf '%s' "$code" > ${quote(result)}
trap - TERM INT
[ "$watchdog" = 0 ] || kill "$watchdog" 2>/dev/null
exit "$code"
`,
            { mode: 0o700 },
          )
          const output = await open(log, "a", 0o600)
          try {
            const child = spawn("/bin/sh", [supervisor], {
              cwd,
              env,
              detached: true,
              stdio: ["ignore", output.fd, output.fd],
            })
            await new Promise<void>((resolve, reject) => {
              child.once("spawn", resolve)
              child.once("error", reject)
            })
            child.unref()
            return child.pid!
          } finally {
            await output.close()
          }
        })()
        const deadline = Date.now() + 5000
        while (
          !(await access(destination).then(
            () => true,
            () => false,
          ))
        ) {
          // The owner is published before executing the command. Keep this bounded
          // wait and the final birth check below without a cold OS query per poll.
          if (Date.now() >= deadline)
            throw new Error("Preview supervisor did not complete durable admission; never retry automatically")
          await scheduler.wait(20)
        }
        const record = await load(owner)
        if (!record || record.pid !== pid || (await birth(pid)) !== record.birth)
          throw new Error("Preview owner identity is unavailable; never retry automatically")
        return pid
      })
      if (onSpawn) yield* onSpawn(pid)
      return yield* restore(
        Effect.tryPromise(async (signal) => {
          while (!signal.aborted) {
            const state = await get(owner)
            if (state?.status !== "running") return state
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 250).unref()
            })
          }
        }),
      ).pipe(Effect.onInterrupt(() => Effect.promise(() => cancel(owner)).pipe(Effect.asVoid)))
    }),
  )
