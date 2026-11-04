import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@zaovra-ai/core/cross-spawn-spawner"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { ProcessTree } from "@zaovra-ai/core/process-tree"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

describe("spawner owned-tree scope disposal", () => {
  if (!ProcessTree.supported()) return
  it.live(
    "retains immediate shell stdout and stderr through delayed consumption and nonzero exit",
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      for (let index = 0; index < (process.platform === "win32" ? 3 : 30); index++) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              process.platform === "win32"
                ? ChildProcess.make(
                    process.env.COMSPEC ?? "cmd.exe",
                    ["/d", "/s", "/c", "echo hello& echo problem 1>&2& exit /b 42"],
                    { stdin: "ignore" },
                  )
                : ChildProcess.make("/bin/sh", ["-c", "printf hello; printf problem >&2; exit 42"], {
                    stdin: "ignore",
                  }),
            )
            // The process may already be closed before its consumers attach.
            yield* Effect.sleep("50 millis")
            const result = yield* Effect.all(
              [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
              { concurrency: "unbounded" },
            )
            expect(
              Buffer.concat(result[0].map((chunk) => Buffer.from(chunk)))
                .toString()
                .trim(),
            ).toBe("hello")
            expect(
              Buffer.concat(result[1].map((chunk) => Buffer.from(chunk)))
                .toString()
                .trim(),
            ).toBe("problem")
            expect(Number(result[2])).toBe(42)
          }),
        )
      }
    }),
    60000,
  )
  it.live(
    "retains fd3 independently through delayed consumption",
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                "-e",
                'require("node:fs").writeSync(3,"extra");process.stdout.write("out");process.stderr.write("err");process.exitCode=42',
              ],
              { stdin: "ignore", additionalFds: { fd3: { type: "output" } } },
            ),
          )
          yield* Effect.sleep("50 millis")
          const values = yield* Effect.all(
            [
              Stream.runCollect(handle.getOutputFd(3)),
              Stream.runCollect(handle.stdout),
              Stream.runCollect(handle.stderr),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          )
          expect(Buffer.concat(values[0].map((x) => Buffer.from(x))).toString()).toBe("extra")
          expect(Buffer.concat(values[1].map((x) => Buffer.from(x))).toString()).toBe("out")
          expect(Buffer.concat(values[2].map((x) => Buffer.from(x))).toString()).toBe("err")
          expect(Number(values[3])).toBe(42)
        }),
      )
    }),
  )
})
