import { expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Logger } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Logging } from "../src/observability/logging"
import { ProcessTree } from "../src/process-tree"

test("unverified cleanup remains queryable in the file log and process event", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zaovra-cleanup-log-"))
  const file = path.join(dir, "cleanup.log")
  const events: ProcessTree.Cleanup[] = []
  const observe = (value: ProcessTree.Cleanup) => events.push(value)
  const listeners = ProcessTree.events.listenerCount("cleanup")
  ProcessTree.events.on("cleanup", observe)
  try {
    const result = await Effect.runPromise(
      Effect.promise(async () => {
        const tool = await ProcessTree.start(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
        try {
          expect(await tool.closed).toEqual([0, null])
          expect(tool.owner.cleanup).toMatchObject({ pid: tool.pid, status: "unverified", observedExited: 0 })
          expect(events.filter((value) => value.pid === tool.pid)).toEqual([tool.owner.cleanup!])
          return tool.pid
        } finally {
          await tool.owner.stop()
        }
      }).pipe(
        Effect.provide(
          Logging.processTreeEvents.pipe(
            Layer.provide(Logger.layer([Logging.fileLogger(file)], { mergeWithExisting: false })),
            Layer.provide(NodeFileSystem.layer),
          ),
        ),
      ),
    )
    const log = await readFile(file, "utf8")
    expect(log).toContain('message="cleanup unverified"')
    expect(log).toContain(`pid=${result}`)
    expect(log).toContain("level=INFO")
    expect(log).toContain("status=unverified")
    expect(log).toContain("observedExited=0")
    expect(ProcessTree.events.listenerCount("cleanup")).toBe(listeners + 1)
  } finally {
    ProcessTree.events.off("cleanup", observe)
    await rm(dir, { recursive: true, force: true })
  }
}, 10000)
