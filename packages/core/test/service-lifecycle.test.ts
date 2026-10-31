import { expect, test } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { PreviewProcess } from "../src/preview-process"
import { tmpdir } from "./fixture/tmpdir"

for (const scenario of [
  { kind: "helper", protocol: "http" },
  { kind: "service", protocol: "http" },
  { kind: "service", protocol: "shell" },
  { kind: "service", protocol: "daemon-shell" },
  { kind: "service", protocol: "git" },
]) {
  test(`461 ${scenario.kind} ${scenario.protocol} lifetime after its owner scope and CLI exit`, async () => {
    await using tmp = await tmpdir()
    const ready = path.join(tmp.path, "ready.json")
    const owner = Bun.spawn(
      [process.execPath, "test/fixture/service-owner.ts", scenario.kind, ready, scenario.protocol],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const ownership = {
      root: tmp.path,
      jobID: "owned-fixture",
      sessionID: "fixture-session",
      directory: path.resolve(import.meta.dir, ".."),
    }
    let child: { pid: number; childPid?: number; port: number } | undefined
    try {
      const exited = await Promise.race([owner.exited, Bun.sleep(10000).then(() => "timeout")])
      const error = exited === "timeout" ? "Owner did not exit" : await new Response(owner.stderr).text()
      expect(error).toBe("")
      expect(exited).toBe(0)
      child = await Bun.file(ready).json()
      if (scenario.kind === "service")
        expect(await PreviewProcess.get(ownership)).toMatchObject({ status: "running", birth: expect.any(String) })
      if (scenario.protocol !== "git") {
        const response = await fetch(`http://127.0.0.1:${child!.port}`, { signal: AbortSignal.timeout(2000) }).catch(
          () => undefined,
        )
        expect(response?.ok === true).toBe(scenario.kind === "service")
        if (response) expect(await response.text()).toBe("service-alive")
      }
      if (scenario.protocol === "git") {
        const probe = Bun.spawn(["git", "ls-remote", `git://127.0.0.1:${child!.port}/repo.git`], {
          stdout: "pipe",
          stderr: "pipe",
        })
        try {
          const exit = await Promise.race([probe.exited, Bun.sleep(3000).then(() => "timeout")])
          expect(exit).toBe(0)
          expect(await new Response(probe.stderr).text()).toBe("")
        } finally {
          probe.kill()
          await probe.exited
        }
      }
    } finally {
      owner.kill()
      await owner.exited
      child ??= (await Bun.file(ready).exists()) ? await Bun.file(ready).json() : undefined
      if (scenario.kind === "service") {
        await PreviewProcess.cancel(ownership)
        if (await PreviewProcess.get(ownership)) expect((await PreviewProcess.get(ownership))?.status).toBe("cancelled")
      }
      if (child) {
        if (process.platform === "win32") {
          const stop = Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
            stdout: "ignore",
            stderr: "ignore",
          })
          await stop.exited
        }
        for (const pid of [child.childPid, child.pid]) {
          if (!pid) continue
          try {
            process.kill(pid)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
          }
        }
      }
    }
  }, 30000)
}

for (const scenario of ["abnormal-owner", "hard-deadline", "stale-birth", "archive"] as const) {
  test(`469 durable preview management: ${scenario}`, async () => {
    await using tmp = await tmpdir()
    const ready = path.join(tmp.path, "ready.json")
    const owner = Bun.spawn(
      [
        process.execPath,
        "test/fixture/service-owner.ts",
        "service",
        ready,
        "http",
        scenario === "hard-deadline" ? "8000" : "",
        scenario === "abnormal-owner" ? "hold" : "normal",
      ],
      { cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    )
    const ownership = {
      root: tmp.path,
      jobID: "owned-fixture",
      sessionID: "fixture-session",
      directory: path.resolve(import.meta.dir, ".."),
    }
    let saved: { file: string; bytes: Buffer } | undefined
    try {
      const deadline = Date.now() + 10000
      while (!(await Bun.file(ready + ".admitted").exists())) {
        if (Date.now() > deadline) throw new Error("Preview admission not observed")
        await Bun.sleep(20)
      }
      if (scenario === "abnormal-owner") owner.kill("SIGKILL")
      const exit = await owner.exited
      if (scenario === "abnormal-owner") expect(exit).not.toBe(0)
      else expect(exit).toBe(0)
      const service = await Bun.file(ready).json()
      expect(await (await fetch(`http://127.0.0.1:${service.port}`)).text()).toBe("service-alive")
      if (scenario === "stale-birth") {
        const records = await fs.readdir(path.join(tmp.path, "preview-processes"))
        const file = path.join(tmp.path, "preview-processes", records[0], "owner.json")
        saved = { file, bytes: await fs.readFile(file) }
        const record = JSON.parse(saved.bytes.toString())
        await Bun.write(file, JSON.stringify({ ...record, birth: "stale-process-identity" }))
        expect((await PreviewProcess.cancel(ownership))?.status).toBe("unavailable")
        expect(await (await fetch(`http://127.0.0.1:${service.port}`)).text()).toBe("service-alive")
        await fs.writeFile(saved.file, saved.bytes)
        saved = undefined
      }
      if (scenario === "hard-deadline") {
        const deadline = Date.now() + 10000
        while ((await PreviewProcess.get(ownership))?.status === "running") {
          if (Date.now() > deadline) throw new Error("Explicit process deadline was not enforced after CLI exit")
          await Bun.sleep(100)
        }
        expect(await PreviewProcess.get(ownership)).toMatchObject({ status: "error", exit: 124 })
      } else if (scenario === "archive") {
        await expect(PreviewProcess.cancel({ ...ownership, sessionID: "another-session" })).rejects.toThrow(
          "another Session",
        )
        await expect(
          PreviewProcess.cancel({ ...ownership, directory: path.dirname(ownership.directory) }),
        ).rejects.toThrow("another Session")
        await PreviewProcess.archive(ownership.root, ownership.sessionID, ownership.directory)
      } else await PreviewProcess.cancel(ownership)
      expect(
        await fetch(`http://127.0.0.1:${service.port}`, { signal: AbortSignal.timeout(1000) }).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      if (saved) await fs.writeFile(saved.file, saved.bytes)
      if (owner.exitCode === null) owner.kill("SIGKILL")
      await owner.exited
      await PreviewProcess.cancel(ownership)
    }
  }, 40000)
}

for (const action of ["cancel", "archive", "wait"] as const) {
  test(`469 real BashJob ${action} and permission checks after a full process restart`, async () => {
    await using tmp = await tmpdir()
    const run = async (mode: string) => {
      const child = Bun.spawn([process.execPath, "test/fixture/preview-session-restart.ts", tmp.path, mode], {
        env: { ...process.env, ZAOVRA_DB: path.join(tmp.path, "fixture.db") },
        cwd: path.resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      })
      try {
        const code = await Promise.race([child.exited, Bun.sleep(30000).then(() => "timeout")])
        if (code !== 0) throw new Error(`Restart fixture ${mode}: ${code}: ${await new Response(child.stderr).text()}`)
      } finally {
        child.kill()
        await child.exited
      }
    }
    const ownership = { root: tmp.path, jobID: "", sessionID: "", directory: tmp.path }
    try {
      await run(action === "wait" ? "start-wait" : "start")
      const saved = await Bun.file(path.join(tmp.path, "state.json")).json()
      Object.assign(ownership, saved)
      const service = await Bun.file(path.join(tmp.path, "ready.json")).json()
      expect(await (await fetch(`http://127.0.0.1:${service.port}`)).text()).toBe("service-alive")
      await run(action)
      expect(await Bun.file(path.join(tmp.path, "managed.json")).json()).toMatchObject({
        mode: action,
        permissionDenied: true,
        otherSessionDenied: true,
        budget: "preserved",
        registry: "empty",
      })
      expect(
        await fetch(`http://127.0.0.1:${service.port}`, { signal: AbortSignal.timeout(1000) }).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      if (ownership.jobID) await PreviewProcess.cancel(ownership)
    }
  }, 60000)
}
