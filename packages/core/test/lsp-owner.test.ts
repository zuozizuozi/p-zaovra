import { expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LSP } from "../src/lsp"
import { LayerNode } from "../src/effect/layer-node"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

it.live(
  "490 source-owned initialization returns promptly, coalesces owners and stops after the final owner releases",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const file = path.join(tmp.path, "source.audit")
      const pidFile = path.join(tmp.path, "server.pid")
      const countFile = path.join(tmp.path, "starts.txt")
      const server = path.join(tmp.path, "server.cjs")
      yield* Effect.promise(async () => {
        await Bun.write(file, "saved content")
        await Bun.write(
          server,
          `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(countFile)}, 'start\\n'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
        )
        await Bun.write(
          path.join(tmp.path, "zaovra.json"),
          JSON.stringify({ lsp: { audit: { extensions: [".audit"], command: [process.execPath, server] } } }),
        )
      })
      yield* Effect.gen(function* () {
        const lsp = yield* LSP.Service
        const started = Date.now()
        expect(yield* lsp.changed(file, "ses_first")).toEqual({ diagnostics: {}, failed: [], pending: ["audit"] })
        expect(yield* lsp.changed(file, "ses_second")).toEqual({ diagnostics: {}, failed: [], pending: ["audit"] })
        expect(Date.now() - started).toBeLessThan(1000)
        const end = Date.now() + 3000
        while (!(yield* Effect.promise(() => Bun.file(pidFile).exists())) && Date.now() < end)
          yield* Effect.sleep("10 millis")
        const pid = Number(yield* Effect.promise(() => Bun.file(pidFile).text()))
        expect(yield* Effect.promise(() => Bun.file(countFile).text())).toBe("start\n")
        yield* lsp.release!("ses_first")
        expect(() => process.kill(pid, 0)).not.toThrow()
        yield* lsp.release!("ses_second")
        yield* Effect.sleep("100 millis")
        expect(() => process.kill(pid, 0)).toThrow()
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("saved content")
      }).pipe(
        Effect.provide(
          LayerNode.compile(LSP.node, [
            [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
          ]),
        ),
      )
    }),
)

it.live("490 owner scope closure interrupts a warming server without an explicit release", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const file = path.join(tmp.path, "source.audit")
    const pidFile = path.join(tmp.path, "server.pid")
    const server = path.join(tmp.path, "server.cjs")
    yield* Effect.promise(async () => {
      await Bun.write(file, "saved content")
      await Bun.write(
        server,
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      )
      await Bun.write(
        path.join(tmp.path, "zaovra.json"),
        JSON.stringify({ lsp: { audit: { extensions: [".audit"], command: [process.execPath, server] } } }),
      )
    })
    const pid = yield* Effect.scoped(
      Effect.gen(function* () {
        const lsp = yield* LSP.Service
        expect((yield* lsp.changed(file, "ses_scope")).pending).toEqual(["audit"])
        const end = Date.now() + 3000
        while (!(yield* Effect.promise(() => Bun.file(pidFile).exists())) && Date.now() < end)
          yield* Effect.sleep("10 millis")
        return Number(yield* Effect.promise(() => Bun.file(pidFile).text()))
      }).pipe(
        Effect.provide(
          LayerNode.compile(LSP.node, [
            [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
          ]),
        ),
      ),
    )
    yield* Effect.sleep("100 millis")
    expect(() => process.kill(pid, 0)).toThrow()
  }),
)

it.live("490 background initialization failure closes the process without waiting for another file edit", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const file = path.join(tmp.path, "source.audit")
    const pidFile = path.join(tmp.path, "server.pid")
    yield* Effect.promise(async () => {
      await Bun.write(file, "saved content")
      await Bun.write(
        path.join(tmp.path, "zaovra.json"),
        JSON.stringify({
          lsp: {
            audit: {
              extensions: [".audit"],
              command: [process.execPath, path.join(import.meta.dirname, "fixture/lsp-init-error.cjs"), pidFile],
            },
          },
        }),
      )
    })
    yield* Effect.gen(function* () {
      const lsp = yield* LSP.Service
      expect((yield* lsp.changed(file, "ses_failure")).pending).toEqual(["audit"])
      const end = Date.now() + 3000
      while (!(yield* lsp.status()).some((item) => item.status === "error") && Date.now() < end)
        yield* Effect.sleep("10 millis")
      expect((yield* lsp.status()).map((item) => item.status)).toEqual(["error"])
      const pid = Number(yield* Effect.promise(() => Bun.file(pidFile).text()))
      yield* Effect.sleep("100 millis")
      expect(() => process.kill(pid, 0)).toThrow()
    }).pipe(
      Effect.provide(
        LayerNode.compile(LSP.node, [
          [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
        ]),
      ),
    )
  }),
)
