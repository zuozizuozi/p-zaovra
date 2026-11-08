import { patchPluginConfig } from "../../src/plugin/install"
import path from "path"
import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { parse } from "jsonc-parser"
import { Config } from "../../src/config/config"
import { Service, node } from "@zaovra-ai/core/config"
import { ConfigFile } from "@zaovra-ai/core/config/file"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { Global } from "@zaovra-ai/core/global"
import { Location } from "@zaovra-ai/core/location"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"
import { location } from "../../../core/test/fixture/location"
import { TestInstance } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(FSUtil.node))
const file = path.join(Global.Path.config, "zaovra.jsonc")
const initial =
  '// keep settings comment\n{"$schema":"https://zaovra.com/config.json","model":"openai/gpt-test","provider":{"openai":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://old.example.invalid/v1"}}}}'

function settings(fs: FSUtil.Interface) {
  return Config.Service.pipe(
    Effect.provide(LayerNode.compile(Config.node, [[FSUtil.node, Layer.succeed(FSUtil.Service, fs)]])),
  )
}

it.live("Settings saving after migration read preserves its endpoint, deny and JSONC comment", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => Bun.write(file, initial))
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let paused = false
    const wrapped = FSUtil.Service.of({
      ...fs,
      writeFileString: (target, text, options) =>
        Effect.gen(function* () {
          if (target === file && !paused) {
            paused = true
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }
          yield* fs.writeFileString(target, text, options)
        }),
    })
    const saved = yield* settings(wrapped)
    const current = yield* Service.pipe(
      Effect.provide(
        AppNodeBuilder.build(node, [
          [FSUtil.node, Layer.succeed(FSUtil.Service, wrapped)],
          [
            Location.node,
            Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make(Global.Path.config) })),
            ),
          ],
        ]),
      ),
    )
    yield* Effect.gen(function* () {
      const migrating = yield* current.activateModels!(["openai"]).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const saving = yield* saved
        .updateGlobal({
          disabled_providers: ["openai"],
          provider: { openai: { options: { baseURL: "https://new.example.invalid/v1" }, whitelist: [] } },
        })
        .pipe(Effect.forkChild)
      yield* Effect.sleep("50 millis")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(migrating)
      const response = yield* Fiber.join(saving)
      const text = yield* Effect.promise(() => Bun.file(file).text())
      const data = parse(text)
      expect(response.changed).toBe(true)
      expect(data.provider.openai.options.baseURL).toBe("https://new.example.invalid/v1")
      expect(data.disabled_providers).toEqual(["openai"])
      expect(data.provider.openai.whitelist).toEqual([])
      expect(data.provider.openai.models).toEqual({ "gpt-test": {} })
      expect(text).toContain("// keep settings comment")
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
  }),
)

it.live("two Settings services merge independent patches under the same file lock", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => Bun.write(file, initial))
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let paused = false
    const wrapped = FSUtil.Service.of({
      ...fs,
      writeFileString: (target, text, options) =>
        Effect.gen(function* () {
          if (target === file && !paused) {
            paused = true
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }
          yield* fs.writeFileString(target, text, options)
        }),
    })
    const first = yield* settings(wrapped)
    const second = yield* settings(wrapped)
    yield* Effect.gen(function* () {
      const a = yield* first.updateGlobal({ username: "writer-a" }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const b = yield* second.updateGlobal({ shell: "synthetic-shell" }).pipe(Effect.forkChild)
      yield* Effect.sleep("50 millis")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(a)
      yield* Fiber.join(b)
      const text = yield* Effect.promise(() => Bun.file(file).text())
      expect(parse(text).username).toBe("writer-a")
      expect(parse(text).shell).toBe("synthetic-shell")
      expect(text).toContain("// keep settings comment")
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
  }),
)

it.live("a failed Settings write is not acknowledged and does not poison later saves", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => Bun.write(file, initial))
    let fail = true
    const wrapped = FSUtil.Service.of({
      ...fs,
      writeFileString: (target, text, options) => {
        if (target !== file || !fail) return fs.writeFileString(target, text, options)
        fail = false
        return fs.writeFileString(path.join(Global.Path.config, "absent718", "config"), text, options)
      },
    })
    const service = yield* settings(wrapped)
    const failure = yield* service.updateGlobal({ username: "not-saved" }).pipe(Effect.exit)
    expect(Exit.isFailure(failure)).toBe(true)
    expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(initial)
    expect((yield* service.updateGlobal({ shell: "next-save" })).changed).toBe(true)
    expect(parse(yield* Effect.promise(() => Bun.file(file).text())).shell).toBe("next-save")
  }),
)

it.live("legacy schema insertion cannot overwrite a later Settings patch", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const source = initial.replace('"$schema":"https://zaovra.com/config.json",', "")
    yield* Effect.promise(() => Bun.write(file, source))
    let injected = false
    const wrapped = FSUtil.Service.of({
      ...fs,
      readFileStringSafe: (target) =>
        fs.readFileStringSafe(target).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              if (target !== file || injected) return
              injected = true
              yield* ConfigFile.update(fs, file, (text) => Effect.succeed(text + "\n// arrived while loading")).pipe(
                Effect.orDie,
              )
            }),
          ),
        ),
    })
    const service = yield* settings(wrapped)
    yield* service.getGlobal()
    const text = yield* Effect.promise(() => Bun.file(file).text())
    expect(text).toContain("// arrived while loading")
    expect(parse(text).provider.openai.options.baseURL).toBe("https://old.example.invalid/v1")
  }),
)

it.instance("directory Settings update serializes with activation of the same document", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const tmp = yield* TestInstance
    const local = path.join(tmp.directory, "zaovra.jsonc")
    yield* Effect.promise(() => Bun.write(local, initial))
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let paused = false
    const wrapped = FSUtil.Service.of({
      ...fs,
      writeFileString: (target, text, options) =>
        Effect.gen(function* () {
          if (target === local && !paused) {
            paused = true
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }
          yield* fs.writeFileString(target, text, options)
        }),
    })
    const service = yield* settings(wrapped)
    const current = yield* Service.pipe(
      Effect.provide(
        AppNodeBuilder.build(node, [
          [FSUtil.node, Layer.succeed(FSUtil.Service, wrapped)],
          [Global.node, Global.layerWith({ config: tmp.directory })],
          [
            Location.node,
            Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make(tmp.directory) })),
            ),
          ],
        ]),
      ),
    )
    yield* Effect.gen(function* () {
      const migrating = yield* current.activateModels!(["openai"]).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const saving = yield* service
        .update({ username: "directory-save", disabled_providers: ["openai"] })
        .pipe(Effect.forkChild)
      yield* Effect.sleep("50 millis")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(migrating)
      yield* Fiber.join(saving)
      const text = yield* Effect.promise(() => Bun.file(local).text())
      expect(parse(text).username).toBe("directory-save")
      expect(parse(text).disabled_providers).toEqual(["openai"])
      expect(parse(text).provider.openai.models).toEqual({ "gpt-test": {} })
      expect(text).toContain("// keep settings comment")
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
  }),
)

it.live("plugin config patch and Settings save use the same file transaction", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => Bun.write(file, initial))
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const service = yield* settings(fs)
    yield* Effect.gen(function* () {
      const patching = yield* Effect.promise(() =>
        patchPluginConfig(
          {
            spec: "synthetic-plugin718",
            targets: [{ kind: "server" }],
            global: true,
            config: Global.Path.config,
            directory: Global.Path.config,
            worktree: Global.Path.config,
          },
          {
            readText: (target) => Bun.file(target).text(),
            exists: (target) => Bun.file(target).exists(),
            files: (dir, name) => [path.join(dir, name + ".jsonc")],
            write: async (target, text) => {
              await Effect.runPromise(Deferred.succeed(entered, undefined))
              await Effect.runPromise(Deferred.await(release))
              await Bun.write(target, text)
            },
          },
        ),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const saving = yield* service.updateGlobal({ shell: "after-plugin" }).pipe(Effect.forkChild)
      yield* Effect.sleep("50 millis")
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(patching)).ok).toBe(true)
      yield* Fiber.join(saving)
      const text = yield* Effect.promise(() => Bun.file(file).text())
      expect(parse(text).shell).toBe("after-plugin")
      expect(parse(text).plugin).toEqual(["synthetic-plugin718"])
      expect(text).toContain("// keep settings comment")
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
  }),
)
