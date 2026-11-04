import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { app, dialog } from "electron"
import { checkHealth } from "../server"
import { type WslCommandLine, resolveWslZaovra, shellEscape, wslArgs, runWslInDistro } from "./runtime"
import { pollWslHealth } from "./startup"
import { createWslStop, wslSidecarScript } from "./lifecycle"
import { CHANNEL } from "../constants"
import { wslUpgradeProgram } from "./upgrade"
import { wslBackendEnvironment, wslProfile } from "./environment"

export type WslSidecar = {
  listener: {
    stop: () => Promise<void>
    onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void
  }
  url: string
  username: string | null
  password: string
}

export async function spawnWslSidecar(
  distro: string,
  opts: { onLine?: (line: WslCommandLine) => void; healthTimeoutMs?: number; allowSharedLegacy?: boolean } = {},
): Promise<WslSidecar> {
  const zaovra = await resolveWslZaovra(distro)
  if (!zaovra) throw new Error(`Zaovra is not installed in ${distro}`)

  const migrate = async (mode: "probe" | "migrate", action = "empty") => {
    const result = await runWslInDistro(
      [
        "python3",
        "-c",
        wslUpgradeProgram,
        CHANNEL,
        wslProfile(app.getPath("userData")),
        mode,
        String(opts.allowSharedLegacy === true),
        action,
      ],
      distro,
      { timeoutMs: 60_000 },
    )
    if (result.code !== 0)
      throw new Error(
        "WSL data preparation failed. Python 3 with SQLite is required; original data is unchanged. " + result.stderr,
      )
    return JSON.parse(result.stdout) as { completed: boolean; available?: boolean }
  }
  const legacy = await migrate("probe")
  if (!legacy.completed) {
    const choice =
      legacy.available && CHANNEL !== "prod"
        ? await dialog.showMessageBox({
            type: "question",
            title: "WSL 数据升级",
            message: "发现此发行版的原有会话和配置",
            detail: "导入会安全复制到此渠道和 profile 的独立目录；原文件保留。",
            buttons: ["导入原有数据（复制）", "从空白开始", "取消"],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
          })
        : undefined
    if (choice?.response === 2) throw new Error("WSL data migration cancelled; original data retained")
    await migrate("migrate", legacy.available && (CHANNEL === "prod" || choice?.response === 0) ? "import" : "empty")
  }

  const port = await allocatePort()
  const password = randomUUID()
  const username = "zaovra"
  const script = [
    "set -euo pipefail",
    'cd "$HOME" || cd /',
    'PATH=$(awk -v RS=: -v ORS=: \'$0 !~ /^\\/mnt\\//\' <<<"$PATH" | sed "s/:$//")',
    "export PATH",
    "export WSLENV=",
    "export ZAOVRA_EXPERIMENTAL_DISABLE_FILEWATCHER=true",
    "export ZAOVRA_CLIENT=desktop",
    `export ZAOVRA_SERVER_USERNAME=${shellEscape(username)}`,
    `export ZAOVRA_SERVER_PASSWORD=${shellEscape(password)}`,
    ...wslBackendEnvironment(CHANNEL, app.getPath("userData")),
    `exec ${shellEscape(zaovra)} --print-logs --log-level ${app.isPackaged ? "WARN" : "INFO"} serve --hostname 0.0.0.0 --port ${port}`,
  ].join("\n")
  const child = spawn("wsl", wslArgs(["bash", "-se"], distro), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const stop = createWslStop(child)

  const recentOutput: string[] = []
  const emit = (line: WslCommandLine) => {
    if (!line.text.trim()) return
    recentOutput.push(`[${line.stream}] ${line.text}`)
    if (recentOutput.length > 12) recentOutput.shift()
    opts.onLine?.(line)
  }
  forwardLines(child.stdout, "stdout", emit)
  forwardLines(child.stderr, "stderr", emit)

  const exit = new Promise<never>((_, reject) => {
    child.once("error", reject)
    child.stdin.once("error", reject)
    child.once("exit", (code, signal) => reject(new Error(startupFailure(code, signal, recentOutput))))
  })
  child.stdin.write(wslSidecarScript(script))
  const url = `http://127.0.0.1:${port}`
  const startup = new AbortController()
  const health = pollWslHealth(() => checkHealth(url, password), startup.signal)
  const timeoutMs = opts.healthTimeoutMs ?? 30_000
  let timeout: ReturnType<typeof setTimeout>
  const timedOut = new Promise<never>(
    (_, reject) =>
      (timeout = setTimeout(
        () => reject(new Error(`Sidecar for ${distro} health check timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )),
  )

  await Promise.race([health, exit, timedOut])
    .catch(async (error) => {
      await stop()
      throw error
    })
    .finally(() => {
      clearTimeout(timeout)
      startup.abort()
    })
  return {
    listener: {
      stop,
      onExit: (cb) => child.once("exit", cb),
    },
    url,
    username,
    password,
  }
}

function allocatePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

function forwardLines(
  stream: NodeJS.ReadableStream,
  source: WslCommandLine["stream"],
  onLine: (line: WslCommandLine) => void,
) {
  let pending = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/g)
    pending = lines.pop() ?? ""
    lines.forEach((text) => onLine({ stream: source, text }))
  })
  stream.on("end", () => {
    if (pending) onLine({ stream: source, text: pending })
  })
}

function startupFailure(code: number | null, signal: NodeJS.Signals | null, recentOutput: string[]) {
  const suffix = recentOutput.length ? `\n${recentOutput.join("\n")}` : ""
  return `WSL server exited before becoming healthy (code=${code ?? "null"} signal=${signal ?? "null"})${suffix}`
}
