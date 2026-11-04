import { describe, expect, test } from "bun:test"
import { text } from "node:stream/consumers"
import type { Readable } from "node:stream"
import { ProcessTree } from "@zaovra-ai/core/process-tree"

describe("native tool owner admission", () => {
  test.skipIf(!ProcessTree.supported())(
    "propagates real tool stdout, PID and status",
    async () => {
      const launched = await ProcessTree.start(
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify({pid:process.pid}),()=>process.exit(42))"],
        { stdio: ["ignore", "pipe", "pipe"], env: process.env },
      )
      try {
        const stdout = text(launched.proc.stdout!)
        const stderr = text(launched.proc.stderr!)
        expect(await launched.closed).toEqual([42, null])
        expect(JSON.parse(await stdout).pid).toBe(launched.pid)
        expect(launched.pid).not.toBe(launched.proc.pid)
        expect(await stderr).toBe("")
      } finally {
        await launched.owner.stop()
      }
    },
    20000,
  )

  test.skipIf(!ProcessTree.supported())(
    "reports missing-command startup failure",
    async () => {
      await expect(
        ProcessTree.start("zaovra-no-such-command-native-owner", [], {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        }).then((result) => result.closed),
      ).rejects.toMatchObject({ code: "ENOENT" })
    },
    20000,
  )

  test.skipIf(!ProcessTree.supported())(
    "keeps descriptor3 separate from the private admission channel",
    async () => {
      const launched = await ProcessTree.start(
        process.execPath,
        ["-e", 'require("node:fs").writeSync(3,"descriptor3-owner623")'],
        { stdio: ["ignore", "pipe", "pipe", "pipe"], env: process.env },
      )
      try {
        const data = text(launched.proc.stdio[3] as Readable)
        expect(await launched.closed).toEqual([0, null])
        expect(await data).toBe("descriptor3-owner623")
      } finally {
        await launched.owner.stop()
      }
    },
    20000,
  )
})
