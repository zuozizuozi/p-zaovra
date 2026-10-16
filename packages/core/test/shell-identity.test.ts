import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"
import { Config } from "@zaovra-ai/core/config"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { describe, expect, test } from "bun:test"
import { ShellIdentity } from "@zaovra-ai/core/shell-identity"
import { Shell } from "@zaovra-ai/core/shell"
import { AppProcess } from "@zaovra-ai/core/process"
import { Effect, Stream } from "effect"

describe("shared shell identity", () => {
  test("terminal, process and environment resolve the same absolute executable", () => {
    const identity = ShellIdentity.resolve()
    expect(identity.path).toBe(Shell.preferred())
    expect(identity.path).toBe(AppProcess.resolveShell())
    expect(ShellIdentity.guidance(identity)).toContain(identity.path)
    expect(identity.version).not.toBe("")
    expect(identity.source).toBe("auto")
  })
  test("explicit unavailable executable never falls back", () => {
    expect(() => ShellIdentity.resolve("zaovra-nonexistent-shell")).toThrow("Configured shell unavailable")
    expect(() => AppProcess.shellCommand("echo SHOULD_NOT_RUN", process.cwd(), "zaovra-nonexistent-shell")).toThrow()
  })
  test("version guidance is stable and specific", () => {
    const base = { path: "powershell.exe", type: "powershell" as const, source: "auto" as const }
    expect(ShellIdentity.guidance({ ...base, version: "5.1" })).toContain("if ($?)")
    expect(ShellIdentity.guidance({ ...base, version: "5.1" })).toContain("curl.exe")
    expect(ShellIdentity.guidance({ ...base, version: "7.3" })).toContain("Supports && and ||")
    expect(ShellIdentity.guidance({ ...base, version: "7.0" })).toContain("Supports && and ||")
  })
  test("UTF8 byte truncation drops incomplete characters only", async () => {
    const bytes = Buffer.from("中🙂文")
    for (let limit = 0; limit <= bytes.length; limit++) {
      const result = await Effect.runPromise(
        AppProcess.collectStream(Stream.make(bytes.subarray(0, 2), bytes.subarray(2, 5), bytes.subarray(5)), limit),
      )
      expect(result.buffer.toString()).not.toContain("�")
      expect(result.buffer.length).toBeLessThanOrEqual(limit)
      expect("中🙂文".startsWith(result.buffer.toString())).toBe(true)
    }
  })
  if (process.platform === "win32")
    test("explicit bash means Git Bash, not WSL", () => {
      const git = ShellIdentity.gitBash()
      if (!git) expect(() => ShellIdentity.resolve("bash")).toThrow()
      if (git) {
        expect(ShellIdentity.resolve("bash").path).toBe(git)
        expect(ShellIdentity.resolve("bash").type).toBe("bash")
      }
    })
})

test("live shell selection notices newly created project config and fails closed on malformed edits", async () => {
  await using dir = await tmpdir()
  const global = path.join(dir.path, "global")
  const project = path.join(dir.path, "project")
  await fs.mkdir(global)
  await fs.mkdir(project)
  const entries = [new Config.Directory({ type: "directory", path: AbsolutePath.make(global) })]
  const location = { directory: project, project: { directory: project } }
  const executable = ShellIdentity.resolve().path
  await fs.writeFile(path.join(global, "zaovra.json"), JSON.stringify({ shell: executable }))
  const initial = ShellIdentity.snapshot(entries, location)
  expect(initial.identity?.source).toBe("global")
  await fs.writeFile(path.join(project, "zaovra.json"), JSON.stringify({ shell: executable }))
  const override = ShellIdentity.snapshot(entries, location)
  expect(override.identity?.source).toBe("project")
  expect(override.configuration).not.toBe(initial.configuration)
  await fs.writeFile(path.join(project, "zaovra.json"), '{"shell":')
  expect(ShellIdentity.snapshot(entries, location).identity).toBeUndefined()
  expect(ShellIdentity.snapshot(entries, location).error).toContain("configuration invalid")
})

if (process.platform === "win32")
  test("isolated discovery falls back to real 5.1 then cmd and never auto-selects Git Bash", async () => {
    await using dir = await tmpdir()
    const script = `import { ShellIdentity } from "./src/shell-identity"; import { Shell } from "./src/shell"; import { AppProcess } from "./src/process"; const x=ShellIdentity.resolve(); if(x.path!==Shell.preferred() || x.path!==AppProcess.resolveShell()) throw Error("identity mismatch"); console.log(JSON.stringify(x));`
    const env = { ...process.env, PATH: "", Path: "", ProgramFiles: dir.path, ZAOVRA_GIT_BASH_PATH: undefined }
    const ps = Bun.spawnSync([process.execPath, "-e", script], { cwd: process.cwd(), env })
    expect(ps.exitCode).toBe(0)
    expect(JSON.parse(ps.stdout.toString()).version).toStartWith("5.1")
    const cmd = Bun.spawnSync(
      [process.execPath, "-e", `process.env.SystemRoot = ${JSON.stringify(dir.path)}; ${script}`],
      {
        cwd: process.cwd(),
        env: { ...env, COMSPEC: path.join(process.env.SystemRoot ?? "C:/Windows", "System32/cmd.exe") },
      },
    )
    expect(cmd.exitCode).toBe(0)
    expect(JSON.parse(cmd.stdout.toString()).type).toBe("cmd")
    const bash = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'import { ShellIdentity } from "./src/shell-identity"; try { ShellIdentity.resolve("bash"); process.exit(1) } catch { process.exit(0) }',
      ],
      { cwd: process.cwd(), env },
    )
    expect(bash.exitCode).toBe(0)
  }, 15000)
