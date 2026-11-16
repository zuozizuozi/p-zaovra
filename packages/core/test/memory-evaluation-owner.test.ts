import { expect, test } from "bun:test"
import path from "node:path"
import { openJob } from "../../../script/evaluation/memory/job"
import { tmpdir } from "./fixture/tmpdir"

test.skipIf(process.platform !== "win32")(
  "host owner binds native replies and confirms requested shutdown",
  async () => {
    await using directory = await tmpdir()
    await using owner = await openJob({
      directory: directory.path,
      log: path.join(directory.path, "child.log"),
      command: [process.execPath, "-e", 'console.log("child-only");setInterval(()=>{},1000)'],
      seconds: 10,
    })
    const inspection = await owner.inspect()
    expect(inspection).toMatchObject({ scope: owner.scope, pid: owner.pid, rootAlive: true })
    expect(inspection.members).toContain(owner.pid)
    const stopped = await owner.stop()
    expect(stopped).toEqual({ scope: owner.scope, pid: owner.pid, remaining: [], rootExit: 143, controllerExit: 0 })
    expect(JSON.stringify(inspection)).not.toContain("child-only")
    await expect(owner.inspect()).rejects.toThrow("evaluation-job-not-available")
  },
)

test.skipIf(process.platform !== "win32")(
  "host cannot turn a native deadline into a successful stop receipt",
  async () => {
    await using directory = await tmpdir()
    await using owner = await openJob({
      directory: directory.path,
      log: path.join(directory.path, "child.log"),
      command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      seconds: 1,
    })
    // This delay exercises the real deadline rather than synchronizing an unrelated background task.
    await Bun.sleep(1300)
    await expect(owner.stop()).rejects.toThrow()
  },
)

test.skipIf(process.platform !== "win32")(
  "host refuses overlapping control operations without corrupting the first",
  async () => {
    await using directory = await tmpdir()
    await using owner = await openJob({
      directory: directory.path,
      log: path.join(directory.path, "child.log"),
      command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      seconds: 10,
    })
    const first = owner.inspect()
    await expect(owner.inspect()).rejects.toThrow("evaluation-job-not-available")
    expect((await first).rootAlive).toBe(true)
    expect((await owner.stop()).remaining).toEqual([])
  },
)

test.skipIf(process.platform !== "win32")(
  "failed native launch preserves an existing child log and produces no owner",
  async () => {
    await using directory = await tmpdir()
    const log = path.join(directory.path, "child.log")
    await Bun.write(log, "original")
    await expect(
      openJob({ directory: directory.path, log, command: [process.execPath, "-e", "process.exit(0)"] }),
    ).rejects.toThrow("evaluation-job-start-failed")
    expect(await Bun.file(log).text()).toBe("original")
  },
)
