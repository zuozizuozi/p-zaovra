export * as ShellIdentity from "./shell-identity"

import path from "node:path"
import { statSync, readFileSync, readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { which } from "./util/which"
import { Context } from "effect"
import { parse, type ParseError } from "jsonc-parser"
import type { Config } from "./config"
import { Global } from "./global"

export type Identity = {
  path: string
  type: "powershell" | "bash" | "cmd" | "posix"
  version: string
  source: "auto" | "global" | "project"
}

export class Unavailable extends Error {
  readonly reason = "shell-unavailable"
  constructor(readonly configured: string) {
    super(`Configured shell unavailable / 配置的 shell 不可用：${configured}`)
  }
}

const versions = new Map<string, string>()

export type Snapshot = { identity?: Identity; error?: string; configuration: string }
export const Current = Context.Reference<Snapshot | undefined>("@zaovra/ShellIdentity", {
  defaultValue: () => undefined,
})

// Config entries belong to a Location generation. Read the selected shell fields again
// so a command awaiting approval cannot cross into a newer configuration unnoticed.
export function snapshot(
  entries: readonly Config.Entry[],
  location?: { directory: string; project: { directory: string } },
): Snapshot {
  const global = entries.find((entry) => entry.type === "directory")?.path ?? Global.Path.config
  const directories: string[] = []
  if (location) {
    let directory = path.resolve(location.directory)
    const root = path.resolve(location.project.directory)
    while (true) {
      directories.unshift(directory)
      if (directory === root || path.dirname(directory) === directory) break
      directory = path.dirname(directory)
    }
  }
  const names = ["zaovra.json", "zaovra.jsonc"]
  const paths = location
    ? [global, ...directories, ...directories.map((directory) => path.join(directory, ".zaovra"))].flatMap(
        (directory) => names.map((name) => path.join(directory, name)),
      )
    : entries.flatMap((entry) =>
        entry.type === "document" ? (entry.path ? [entry.path] : []) : names.map((name) => path.join(entry.path, name)),
      )
  const values = [...new Set(paths)].map((file) => {
    if (!statSync(file, { throwIfNoEntry: false })) return { path: file, shell: undefined }
    const errors: ParseError[] = []
    const raw: unknown = parse(readFileSync(file, "utf8"), errors, { allowTrailingComma: true })
    const invalid =
      errors.length > 0 ||
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      ("shell" in raw && typeof raw.shell !== "string")
    return {
      path: file,
      shell: raw && typeof raw === "object" && "shell" in raw && typeof raw.shell === "string" ? raw.shell : undefined,
      invalid,
    }
  })
  const injected = entries.flatMap((entry) =>
    entry.type === "document" && !entry.path ? [{ path: undefined, shell: entry.info.shell }] : [],
  )
  const configuration = JSON.stringify([...values, ...injected])
  const invalid = values.find((item) => item.invalid)
  if (invalid) return { error: `Shell configuration invalid / Shell 配置无效：${invalid.path}`, configuration }
  const selected = [...values, ...injected].findLast((item) => item.shell !== undefined)
  const relative = selected?.path ? path.relative(global, selected.path) : undefined
  const source =
    relative !== undefined && !path.isAbsolute(relative) && !relative.startsWith("..") ? "global" : "project"
  try {
    // Only project-provided programs need execution authorization. Preserve
    // trusted automatic/global discovery's version filtering and guidance.
    return { identity: resolve(selected?.shell, source, !selected?.shell || source === "global"), configuration }
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error
    return { error: error.message, configuration }
  }
}

export function gitBash() {
  const git = which("git")
  const candidates = [
    process.env.ZAOVRA_GIT_BASH_PATH,
    git && path.resolve(git, "../../bin/bash.exe"),
    git && path.resolve(git, "../../../bin/bash.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git/bin/bash.exe"),
  ]
  return candidates.find((file): file is string => !!file && !!statSync(file, { throwIfNoEntry: false })?.isFile())
}

export function resolve(
  configured?: string,
  source: Identity["source"] = configured ? "global" : "auto",
  inspect = true,
): Identity {
  const windows = process.platform === "win32"
  const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
  const candidates = configured
    ? windows && /^(bash|powershell|pwsh)(\.exe)?$/i.test(configured)
      ? /^bash/i.test(configured)
        ? [gitBash()]
        : /^pwsh/i.test(configured)
          ? [which("pwsh")]
          : [which("powershell") ?? system]
      : [path.isAbsolute(configured) ? configured : which(configured)]
    : windows
      ? [...powershells(inspect), system, process.env.COMSPEC ?? which("cmd")]
      : [which("bash"), "/bin/sh"]
  for (const candidate of candidates) {
    if (!candidate || !statSync(candidate, { throwIfNoEntry: false })?.isFile()) continue
    const executable = path.resolve(candidate)
    const name = path
      .basename(executable)
      .replace(/\.exe$/i, "")
      .toLowerCase()
    const type =
      name === "pwsh" || name === "powershell"
        ? "powershell"
        : name === "cmd"
          ? "cmd"
          : name === "bash"
            ? "bash"
            : "posix"
    // Context construction and approval metadata must never execute the selected program.
    const version = inspect ? probe(executable, type) : "unknown"
    if (!version) {
      if (configured) throw new Unavailable(configured)
      continue
    }
    if (inspect && !configured && windows && type === "powershell" && name === "pwsh" && Number(version.split(".")[0]) < 7)
      continue
    return { path: executable, type, version, source: configured ? source : "auto" }
  }
  throw new Unavailable(configured ?? "auto")
}

function powershells(inspect: boolean) {
  const directory = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell")
  const installed = statSync(directory, { throwIfNoEntry: false })?.isDirectory()
    ? readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !/preview/i.test(entry.name))
        .map((entry) => path.join(directory, entry.name, "pwsh.exe"))
    : []
  return [...new Set([which("pwsh"), ...installed])]
    .filter((file): file is string => !!file && !!statSync(file, { throwIfNoEntry: false })?.isFile())
    .map((file) => ({ file, version: inspect ? probe(file, "powershell") : "unknown" }))
    .filter((item) => !inspect || (!!item.version && Number(item.version.split(".")[0]) >= 7))
    .sort((left, right) => right.version!.localeCompare(left.version!, undefined, { numeric: true }))
    .map((item) => item.file)
}

function probe(executable: string, type: Identity["type"]) {
  const stamp = statSync(executable)
  const key = `${process.platform === "win32" ? executable.toLowerCase() : executable}:${stamp.mtimeMs}:${stamp.size}`
  const cached = versions.get(key)
  if (cached) return cached
  const args =
    type === "powershell"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]
      : type === "cmd"
        ? ["/d", "/c", "ver"]
        : ["--version"]
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 65536 })
  if (result.error || result.signal || (result.status !== 0 && type !== "posix")) return
  // Some POSIX /bin/sh implementations do not have --version; their executable identity still remains explicit.
  const version =
    `${result.stdout ?? ""}`.match(/\d+\.\d+(?:\.\d+)*/)?.[0] ?? (type === "posix" ? "unknown" : undefined)
  if (version) versions.set(key, version)
  return version
}

export function guidance(shell: Identity) {
  const identity = `Execution shell: ${shell.type} ${shell.version}; ${shell.path}; source=${shell.source}.`
  if (shell.type === "powershell")
    return `${identity} ${Number(shell.version.split(".")[0]) >= 7 ? "Supports && and ||." : "Does not support && or ||; use if ($?) { } for dependent commands."} Use curl.exe, $env:NAME, and explicit -Encoding utf8 when writing files. Quote literal @ arguments. For multiline embedded code write a script file and invoke it.`
  if (shell.type === "cmd")
    return `${identity} Use %NAME% for environment variables. No Bash/PowerShell syntax. For multiple lines write and invoke a .cmd file.`
  return `${identity} Use POSIX quoting and $NAME for environment variables. No PowerShell syntax.`
}

export function same(left: Identity, right: Identity) {
  return (
    left.path === right.path &&
    left.type === right.type &&
    left.version === right.version &&
    left.source === right.source
  )
}
