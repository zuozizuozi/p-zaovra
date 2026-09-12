import { expect } from "bun:test"
import path from "path"
import { Effect, Exit } from "effect"
import { LSPProcess } from "../src/lsp/process"
import { FSUtil } from "../src/fs-util"
import { AppProcess } from "../src/process"
import { LayerNode } from "../src/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, AppProcess.node])))

it.live("opens a real language server and closes its connection with the scope", () =>
  Effect.gen(function* () {
    const state = { disposed: false }
    yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* LSPProcess.open({
          serverID: "fake",
          command: [
            process.execPath,
            path.resolve(import.meta.dirname, "../../zaovra/test/fixture/lsp/fake-lsp-server.js"),
          ],
          root: process.cwd(),
          directory: process.cwd(),
        })
        expect(client.serverID).toBe("fake")
        client.connection.onDispose(() => {
          state.disposed = true
        })
      }),
    )
    expect(state.disposed).toBe(true)
  }),
)

it.live("reports a missing executable without waiting for initialization timeout", () =>
  Effect.gen(function* () {
    const started = Date.now()
    const result = yield* Effect.exit(
      Effect.scoped(
        LSPProcess.open({
          serverID: "missing",
          command: ["zaovra-nonexistent-lsp-test"],
          root: process.cwd(),
          directory: process.cwd(),
        }),
      ),
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  }),
)
