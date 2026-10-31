export * as PreviewProcess from "./preview-process"

import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, readdir, open } from "node:fs/promises"
import { spawn } from "node:child_process"
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
const native = `
$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('PreviewNative'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$module=$assembly.DefineDynamicModule('PreviewNative')
$type=$module.DefineType('PreviewNative',[Reflection.TypeAttributes]::Public)
function Import-Native([string]$name,[Type]$result,[Type[]]$parameters) {
 $method=$type.DefinePInvokeMethod($name,'kernel32.dll',[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$result,$parameters,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
 $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
Import-Native GetCurrentProcess ([IntPtr]) @()
Import-Native CreateProcessW ([bool]) @([IntPtr],[Text.StringBuilder],[IntPtr],[IntPtr],[bool],[uint32],[IntPtr],[string],[IntPtr],[IntPtr])
Import-Native CreateJobObjectW ([IntPtr]) @([IntPtr],[IntPtr])
Import-Native SetInformationJobObject ([bool]) @([IntPtr],[int],[IntPtr],[uint32])
Import-Native AssignProcessToJobObject ([bool]) @([IntPtr],[IntPtr])
Import-Native ResumeThread ([uint32]) @([IntPtr])
Import-Native CloseHandle ([bool]) @([IntPtr])
Import-Native WaitForSingleObject ([uint32]) @([IntPtr],[uint32])
Import-Native GetExitCodeProcess ([bool]) @([IntPtr],[IntPtr])
Import-Native QueryInformationJobObject ([bool]) @([IntPtr],[int],[IntPtr],[uint32],[IntPtr])
Import-Native TerminateJobObject ([bool]) @([IntPtr],[uint32])
Import-Native TerminateProcess ([bool]) @([IntPtr],[uint32])
Import-Native CreateFileW ([IntPtr]) @([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr])
Import-Native GetLastError ([uint32]) @()
$null=$type.CreateType()
function Native-Error { throw [ComponentModel.Win32Exception]::new([int][PreviewNative]::GetLastError()) }
function Native-Buffer([int]$size) { $memory=[Runtime.InteropServices.Marshal]::AllocHGlobal($size); [Runtime.InteropServices.Marshal]::Copy([byte[]]::new($size),0,$memory,$size); return $memory }
function Native-Launch([string]$line,[string]$directory,[bool]$independent,[int]$deadline,[string]$log) {
 if([IntPtr]::Size -ne 8){throw 'Persistent previews require 64-bit Windows'}
 $si=Native-Buffer 104; $pi=Native-Buffer 24; $limits=Native-Buffer 144; $sa=Native-Buffer 24
 $processHandle=[IntPtr]::Zero; $thread=[IntPtr]::Zero; $job=[IntPtr]::Zero; $outputHandle=[IntPtr]::Zero; $inputHandle=[IntPtr]::Zero
 try {
  [Runtime.InteropServices.Marshal]::WriteInt32($si,104); [Runtime.InteropServices.Marshal]::WriteInt32($si,60,1)
  if(!$independent){
   [Runtime.InteropServices.Marshal]::WriteInt32($sa,24); [Runtime.InteropServices.Marshal]::WriteInt32($sa,16,1)
   $outputHandle=[PreviewNative]::CreateFileW($log,4,3,$sa,4,0,[IntPtr]::Zero)
   $inputHandle=[PreviewNative]::CreateFileW('NUL',2147483648,3,$sa,3,0,[IntPtr]::Zero)
   if($outputHandle.ToInt64() -eq -1 -or $inputHandle.ToInt64() -eq -1){Native-Error}
   [Runtime.InteropServices.Marshal]::WriteInt32($si,60,257)
   [Runtime.InteropServices.Marshal]::WriteIntPtr($si,80,$inputHandle); [Runtime.InteropServices.Marshal]::WriteIntPtr($si,88,$outputHandle); [Runtime.InteropServices.Marshal]::WriteIntPtr($si,96,$outputHandle)
  }
  $flags=20; if($independent){$flags=$flags -bor 16777216}
  if(!$independent){
   $job=[PreviewNative]::CreateJobObjectW([IntPtr]::Zero,[IntPtr]::Zero); [Runtime.InteropServices.Marshal]::WriteInt32($limits,16,8192)
   if($job -eq [IntPtr]::Zero -or ![PreviewNative]::SetInformationJobObject($job,9,$limits,144) -or ![PreviewNative]::AssignProcessToJobObject($job,[PreviewNative]::GetCurrentProcess())){Native-Error}
   # Joining before CreateProcess makes child membership atomic. Keep the sole
   # Job handle until the supervisor exits, after it writes its durable result.
   $script:PreviewJob=$job
  }
  if(![PreviewNative]::CreateProcessW([IntPtr]::Zero,[Text.StringBuilder]::new($line),[IntPtr]::Zero,[IntPtr]::Zero,!$independent,$flags,[IntPtr]::Zero,$directory,$si,$pi)){Native-Error}
  $processHandle=[Runtime.InteropServices.Marshal]::ReadIntPtr($pi,0); $thread=[Runtime.InteropServices.Marshal]::ReadIntPtr($pi,8); $processID=[Runtime.InteropServices.Marshal]::ReadInt32($pi,16)
  $clock=[Diagnostics.Stopwatch]::StartNew()
  $null=[PreviewNative]::ResumeThread($thread)
  if($independent){return $processID}
  $wait=[uint32]::MaxValue; if($deadline -gt 0){$wait=[uint32]$deadline}
  if([PreviewNative]::WaitForSingleObject($processHandle,$wait) -eq 258){[IO.File]::WriteAllText([IO.Path]::Combine([IO.Path]::GetDirectoryName($log),'result.json'),'124');$null=[PreviewNative]::TerminateJobObject($job,124); $null=[PreviewNative]::WaitForSingleObject($processHandle,5000);return 124}
  if(![PreviewNative]::GetExitCodeProcess($processHandle,$limits)){Native-Error};$code=[Runtime.InteropServices.Marshal]::ReadInt32($limits)
  while($true){
   if(![PreviewNative]::QueryInformationJobObject($job,1,$limits,48,[IntPtr]::Zero)){Native-Error}
   if([Runtime.InteropServices.Marshal]::ReadInt32($limits,40) -le 1){break}
   if($deadline -gt 0 -and $clock.ElapsedMilliseconds -ge $deadline){[IO.File]::WriteAllText([IO.Path]::Combine([IO.Path]::GetDirectoryName($log),'result.json'),'124');$null=[PreviewNative]::TerminateJobObject($job,124);return 124}
   [Threading.Thread]::Sleep(50)
  }
  return $code
 } finally {
  foreach($handle in @($thread,$processHandle,$outputHandle,$inputHandle)){if($handle -ne [IntPtr]::Zero -and $handle.ToInt64() -ne -1){$null=[PreviewNative]::CloseHandle($handle)}}
  foreach($memory in @($si,$pi,$limits,$sa)){[Runtime.InteropServices.Marshal]::FreeHGlobal($memory)}
 }
}`

const setup = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; `
async function windowsProcess(pid: number, stop?: string) {
  const { dlopen, FFIType, ptr } = await import("bun:ffi")
  const lib = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
    GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
  })
  const handle = lib.symbols.OpenProcess(0x101000 | (stop ? 1 : 0), false, pid)
  try {
    if (!handle || lib.symbols.WaitForSingleObject(handle, 0) !== 258) return
    const created = Buffer.alloc(8)
    const exited = Buffer.alloc(8)
    const kernel = Buffer.alloc(8)
    const user = Buffer.alloc(8)
    if (!lib.symbols.GetProcessTimes(handle, ptr(created), ptr(exited), ptr(kernel), ptr(user)))
      throw new Error("Cannot read preview creation identity; no process was signalled")
    const identity = created.readBigUInt64LE().toString()
    if (stop && identity === stop) {
      if (!lib.symbols.TerminateProcess(handle, 143) || lib.symbols.WaitForSingleObject(handle, 5000) !== 0)
        throw new Error("Owned preview cancellation did not complete")
    }
    return identity
  } finally {
    if (handle) lib.symbols.CloseHandle(handle)
    lib.close()
  }
}

async function launchWindows(line: string, directory: string, env?: NodeJS.ProcessEnv) {
  const { dlopen, FFIType, ptr } = await import("bun:ffi")
  const lib = dlopen("kernel32.dll", {
    CreateProcessW: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.bool,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.bool,
    },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
    GetLastError: { args: [], returns: FFIType.u32 },
  })
  const startup = Buffer.alloc(104)
  startup.writeUInt32LE(104)
  startup.writeUInt32LE(1, 60)
  const processInfo = Buffer.alloc(24)
  const command = Buffer.from(line + "\0", "utf16le")
  const cwd = Buffer.from(directory + "\0", "utf16le")
  const environment = env
    ? Buffer.from(
        Object.entries(env)
          .filter((entry) => entry[1] !== undefined)
          .sort((a, b) => a[0].toUpperCase().localeCompare(b[0].toUpperCase()))
          .map(([key, value]) => `${key}=${value}`)
          .join("\0") + "\0\0",
        "utf16le",
      )
    : undefined
  try {
    // BREAKAWAY_FROM_JOB must succeed; never claim survival inside the CLI Job.
    if (
      !lib.symbols.CreateProcessW(
        null,
        ptr(command),
        null,
        null,
        false,
        0x1000410,
        environment ? ptr(environment) : null,
        ptr(cwd),
        ptr(startup),
        ptr(processInfo),
      )
    )
      throw new Error(`Cannot launch independent preview supervisor: Windows ${lib.symbols.GetLastError()}`)
    return processInfo.readUInt32LE(16)
  } finally {
    for (const offset of [0, 8]) {
      const handle = Number(processInfo.readBigUInt64LE(offset))
      if (handle) lib.symbols.CloseHandle(handle as import("bun:ffi").Pointer)
    }
    lib.close()
  }
}

export async function birth(pid: number) {
  if (process.platform === "win32") return windowsProcess(pid)
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
  const cancelled = await Bun.file(path.join(folder(owner), "cancelled")).exists()
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

/** Identity check and signalling share an OS handle, so PID reuse cannot select a new process. */
export async function cancel(owner: Owner) {
  const record = await load(owner)
  if (!record || (await birth(record.pid)) !== record.birth) return get(owner)
  if (process.platform === "win32") {
    if ((await windowsProcess(record.pid, record.birth)) !== record.birth) return get(owner)
  } else {
    const { dlopen, FFIType } = await import("bun:ffi")
    const libc = dlopen("libc.so.6", {
      syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    })
    const fd = Number(libc.symbols.syscall(434, record.pid, 0, 0, 0))
    try {
      if (fd < 0) throw new Error("Cannot acquire pidfd; preview was not signalled")
      if ((await birth(record.pid)) !== record.birth) return get(owner)
      if (Number(libc.symbols.syscall(424, fd, 15, 0, 0)) !== 0) throw new Error("Preview signal failed")
    } finally {
      if (fd >= 0) libc.symbols.close(fd)
      libc.close()
    }
  }
  await writeFile(path.join(folder(owner), "cancelled"), "cancelled", { mode: 0o600 })
  for (let count = 0; count < 100 && (await birth(record.pid)) === record.birth; count++) await Bun.sleep(20)
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
        const args = shell
          ? process.platform === "win32"
            ? ["/d", "/s", "/c", script]
            : ["-c", script]
          : command.args.map(String)
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
            const child = shell
              ? `${winquote(executable)} /d /s /c "${script}"`
              : [executable, ...argv].map(winquote).join(" ")
            const supervisor = path.join(dir, "supervisor.ps1")
            await writeFile(
              supervisor,
              `\uFEFF${setup}${native}\n$ownership=${psquote(ownership)} | ConvertFrom-Json\n$ownership | Add-Member -NotePropertyName pid -NotePropertyValue $PID\n$ownership | Add-Member -NotePropertyName birth -NotePropertyValue ([string][Diagnostics.Process]::GetCurrentProcess().StartTime.ToFileTimeUtc())\n[IO.File]::WriteAllText(${psquote(temporary)},($ownership | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))\n[IO.File]::Move(${psquote(temporary)},${psquote(destination)})\n$code=Native-Launch ${psquote(child)} ${psquote(cwd)} $false ${timeout ?? 0} ${psquote(log)}\n[IO.File]::WriteAllText(${psquote(result)},[string]$code)\nexit $code`,
              { mode: 0o600 },
            )
            const line = [
              "powershell.exe",
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
            return launchWindows(line, cwd, env)
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
printf '%s,"pid":%s,"birth":"%s:%s"}' ${quote(ownership.slice(0, -1))} "$$" "$boot" "$1" > ${quote(temporary)}
mv ${quote(temporary)} ${quote(destination)} || exit 125
watchdog=0
${timeout === undefined ? "" : `(sleep ${(timeout / 1000).toFixed(3)}; printf 124 > ${quote(result)}; kill -TERM -$$) &\nwatchdog=$!\n`}
${[executable, ...args].map(quote).join(" ")} &
child=$!
wait "$child"
code=$?
# A launching shell may exit after nohup/& while its service remains in this
# owned group. Keep supervision and the original deadline until it ends.
while :; do
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
        while (!(await Bun.file(destination).exists())) {
          if (Date.now() >= deadline || !(await birth(pid)))
            throw new Error("Preview supervisor did not complete durable admission; never retry automatically")
          await Bun.sleep(20)
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
