import { expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Layer } from "effect"
import { LSP } from "../src/lsp"
import { EventV2 } from "../src/event"
import { LspEvent } from "@zaovra-ai/schema/lsp-event"
import { LayerNode } from "../src/effect/layer-node"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

it.live(
  "bounds a hung language server and releases its process after timeout",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const pidFile = path.join(tmp.path, "server.pid")
      const server = path.join(tmp.path, "server.cjs")
      const file = path.join(tmp.path, "sample.audit")
      yield* Effect.promise(() => Bun.write(file, "saved content"))
      yield* Effect.promise(() =>
        Bun.write(
          server,
          `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, "zaovra.json"),
          JSON.stringify({
            lsp: {
              hung: {
                extensions: [".audit"],
                command: [process.execPath, server],
              },
            },
          }),
        ),
      )
      yield* Effect.gen(function* () {
        const lsp = yield* LSP.Service
        const started = Date.now()
        expect(yield* lsp.changed(file)).toEqual({ diagnostics: {}, failed: ["diagnostic timeout"] })
        expect(Date.now() - started).toBeLessThan(25_000)
        const pid = Number(yield* Effect.promise(() => Bun.file(pidFile).text()))
        expect(() => process.kill(pid, 0)).toThrow()
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("saved content")
        yield* Effect.promise(() =>
          Bun.write(
            server,
            `process.argv[2] = ${JSON.stringify(path.join(tmp.path, "server.log"))}; require(${JSON.stringify(path.join(import.meta.dirname, "fixture/lsp-diagnostics.cjs"))})`,
          ),
        )
        const recovered = yield* lsp.changed(file)
        expect(recovered.failed).toEqual([])
        expect(Object.values(recovered.diagnostics).flat()).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "server.log")).text())).toBe(
          "initialize\nopen\n",
        )
      }).pipe(
        Effect.provide(
          LayerNode.compile(LSP.node, [
            [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
          ]),
        ),
      )
    }),
  40_000,
)

it.live("discovers built-in servers and keeps separate connections for nested project roots", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() => Bun.write(path.join(tmp.path, "zaovra.json"), JSON.stringify({ lsp: true })))
    for (const name of ["one", "two"]) {
      const root = path.join(tmp.path, name)
      yield* Effect.promise(async () => {
        await Bun.write(path.join(root, "biome.json"), "{}")
        await Bun.write(path.join(root, "sample.css"), "bad")
        await Bun.write(
          path.join(root, "node_modules/.bin/biome"),
          `#!/usr/bin/env node\nprocess.argv[2] = ${JSON.stringify(path.join(root, "server.log"))}; require(${JSON.stringify(path.join(import.meta.dirname, "fixture/lsp-diagnostics.cjs"))})`,
        )
        const fs = await import("fs/promises")
        await fs.chmod(path.join(root, "node_modules/.bin/biome"), 0o755)
      })
    }
    yield* Effect.gen(function* () {
      const lsp = yield* LSP.Service
      for (const name of ["one", "two", "one"]) {
        const result = yield* lsp.changed(path.join(tmp.path, name, "sample.css"))
        expect(result.failed).toEqual([])
        expect(Object.values(result.diagnostics).flat()).toMatchObject([{ message: "Bad text" }])
      }
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "one/server.log")).text())).toBe(
        "initialize\nopen\nchange\n",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "two/server.log")).text())).toBe(
        "initialize\nopen\n",
      )
    }).pipe(
      Effect.provide(
        LayerNode.compile(LSP.node, [
          [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
        ]),
      ),
    )
  }),
)

it.live("reuses a configured language server and replaces diagnostics after a file changes", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const file = path.join(tmp.path, "sample.audit")
    const log = path.join(tmp.path, "server.log")
    yield* Effect.promise(() =>
      Bun.write(
        path.join(tmp.path, "zaovra.json"),
        JSON.stringify({
          lsp: {
            test: {
              command: [process.execPath, path.join(import.meta.dirname, "fixture/lsp-diagnostics.cjs"), log],
              extensions: [".audit"],
            },
          },
        }),
      ),
    )
    yield* Effect.promise(() => Bun.write(file, "bad"))
    yield* Effect.gen(function* () {
      const lsp = yield* LSP.Service
      const first = yield* Effect.all([lsp.changed(file), lsp.changed(file)], { concurrency: "unbounded" })
      for (const result of first) {
        expect(result.failed).toEqual([])
        expect(Object.values(result.diagnostics).flat()).toMatchObject([{ severity: 1, message: "Bad text" }])
      }
      yield* Effect.promise(() => Bun.write(file, "good"))
      const second = yield* lsp.changed(file)
      expect(second.failed).toEqual([])
      expect(Object.values(second.diagnostics).flat()).toEqual([])
      expect(yield* Effect.promise(() => Bun.file(log).text())).toBe("initialize\nopen\nchange\nchange\n")
      expect(yield* lsp.changed(path.join(tmp.path, "../outside.audit"))).toEqual({ diagnostics: {}, failed: [] })
      yield* Effect.promise(() => Bun.write(file, "bad"))
      expect(Object.values((yield* lsp.changed(file)).diagnostics).flat()).toHaveLength(1)
      yield* Effect.promise(() => Bun.file(file).delete())
      expect(yield* lsp.removed(file)).toEqual({ diagnostics: { [file]: [] }, failed: [] })
      const other = path.join(tmp.path, "other.audit")
      yield* Effect.promise(() => Bun.write(other, "good"))
      expect(Object.values((yield* lsp.changed(other)).diagnostics).flat()).toEqual([])
      yield* Effect.promise(() => Bun.write(file, "bad"))
      expect((yield* lsp.changed(file)).diagnostics[file]).toMatchObject([{ message: "Bad text" }])
      expect(yield* Effect.promise(() => Bun.file(log).text())).toBe(
        "initialize\nopen\nchange\nchange\nchange\nclose\nopen\nopen\n",
      )
    }).pipe(
      Effect.provide(
        LayerNode.compile(LSP.node, [
          [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
        ]),
      ),
    )
  }),
)

it.live("retries a language server after its executable becomes available", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const file = path.join(tmp.path, "sample.audit")
    const executable = path.join(tmp.path, "server.cjs")
    yield* Effect.promise(() =>
      Bun.write(
        path.join(tmp.path, "zaovra.json"),
        JSON.stringify({
          lsp: { test: { command: [process.execPath, executable], extensions: [".audit"] } },
        }),
      ),
    )
    yield* Effect.promise(() => Bun.write(file, "bad"))
    yield* Effect.gen(function* () {
      const lsp = yield* LSP.Service
      expect(yield* lsp.status()).toEqual([])
      const events = yield* EventV2.Service
      const before = (yield* events.publish(LspEvent.Updated, {})).id
      expect(yield* lsp.changed(file)).toEqual({ diagnostics: {}, failed: ["test"] })
      expect(yield* lsp.status()).toEqual([{ id: "test", name: "test", root: "", status: "error" }])
      yield* lsp.changed(file)
      const failedEvents = events.recentAfter(before).events.filter((event) => event.type === "lsp.updated")
      expect(failedEvents).toHaveLength(1)
      expect(failedEvents[0]?.location?.directory).toBe(AbsolutePath.make(tmp.path))
      yield* Effect.promise(() =>
        Bun.write(
          executable,
          `require('fs').writeFileSync(${JSON.stringify(path.join(tmp.path, "connected.pid"))}, String(process.pid)); process.argv[2] = ${JSON.stringify(path.join(tmp.path, "server.log"))}; require(${JSON.stringify(path.join(import.meta.dirname, "fixture/lsp-diagnostics.cjs"))})`,
        ),
      )
      const recovered = yield* lsp.changed(file)
      expect(recovered.failed).toEqual([])
      expect(yield* lsp.status()).toEqual([{ id: "test", name: "test", root: "", status: "connected" }])
      expect(events.recentAfter(before).events.filter((event) => event.type === "lsp.updated")).toHaveLength(2)
      expect(Object.values(recovered.diagnostics).flat()).toMatchObject([{ message: "Bad text" }])
      const disconnected = yield* Deferred.make<void>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === "lsp.updated" && event.location?.directory === tmp.path
          ? Deferred.succeed(disconnected, undefined).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const pid = Number(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "connected.pid")).text()))
      yield* Effect.sync(() => process.kill(pid))
      yield* Deferred.await(disconnected).pipe(Effect.timeout("3 seconds"))
      expect(yield* lsp.status()).toEqual([{ id: "test", name: "test", root: "", status: "error" }])
    }).pipe(
      Effect.provide(
        LayerNode.compile(LayerNode.group([LSP.node, EventV2.node]), [
          [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
        ]),
      ),
    )
  }),
)
