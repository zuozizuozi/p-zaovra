import path from "path"
import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { parse } from "jsonc-parser"
import { Config } from "../../src/config"
import { ConfigFile } from "../../src/config/file"
import { FSUtil } from "../../src/fs-util"
import { Global } from "../../src/global"
import { Location } from "../../src/location"
import { AbsolutePath } from "../../src/schema"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(FSUtil.node))
const original =
  '// keep comment\n{"model":"openai/gpt-test","providers":{"openai":{"name":"Gateway","api":{"type":"aisdk","package":"@ai-sdk/openai-compatible","url":"https://old.example.invalid/v1"}}}}'

function config(directory: string, global: string, fs: FSUtil.Interface) {
  return Config.Service.pipe(
    Effect.provide(
      AppNodeBuilder.build(Config.node, [
        [FSUtil.node, Layer.succeed(FSUtil.Service, fs)],
        [Global.node, Global.layerWith({ config: global })],
        [
          Location.node,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ],
      ]),
    ),
  )
}

it.live("two Locations serialize activation and publish only the persisted model", () =>
  Effect.acquireUseRelease(
    Effect.promise(tmpdir),
    (tmp) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const file = path.join(tmp.path, "zaovra.jsonc")
        yield* Effect.promise(() => Bun.write(file, original))
        const writes: string[] = []
        const tracked = FSUtil.Service.of({
          ...fs,
          writeFileString: (target, text, options) =>
            fs.writeFileString(target, text, options).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (target === file) writes.push(text)
                }),
              ),
            ),
        })
        const first = yield* config(tmp.path, tmp.path, tracked)
        const second = yield* config(path.join(tmp.path, "other"), tmp.path, tracked)
        yield* Effect.all([first.activateModels!(["openai"]), second.activateModels!(["openai"])], {
          concurrency: "unbounded",
        })
        const text = yield* Effect.promise(() => Bun.file(file).text())
        expect(writes).toHaveLength(1)
        expect(text).toContain("// keep comment")
        expect(parse(text).providers.openai.models).toEqual({ "gpt-test": {} })
        for (const service of [first, second]) {
          expect(Config.latest(yield* service.entries(), "providers")?.openai.models).toEqual({ "gpt-test": {} })
        }
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("an external edit completed after the activation read is preserved and adopted", () =>
  Effect.acquireUseRelease(
    Effect.promise(tmpdir),
    (tmp) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const file = path.join(tmp.path, "zaovra.jsonc")
        const newer =
          '// external comment\n{"model":"openai/gpt-test","provider_filter":{"deny":["openai"]},"providers":{"openai":{"filter":{"allow":[]},"api":{"type":"aisdk","package":"@ai-sdk/openai-compatible","url":"https://new.example.invalid/v1"}}}}'
        yield* Effect.promise(() => Bun.write(file, original))
        let armed = false
        const read = (target: string) =>
          fs.readFileString(target).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                if (target !== file || !armed) return
                armed = false
                yield* Effect.promise(() => Bun.write(file, newer))
              }),
            ),
          )
        const wrapped = FSUtil.Service.of({
          ...fs,
          readFileString: (target, encoding) => (encoding ? fs.readFileString(target, encoding) : read(target)),
          readFileStringSafe: (target) => (target === file ? read(target) : fs.readFileStringSafe(target)),
        })
        const service = yield* config(tmp.path, tmp.path, wrapped)
        armed = true
        yield* service.activateModels!(["openai"])
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(newer)
        const entries = yield* service.entries()
        expect(Config.latest(entries, "providers")?.openai.api?.url).toBe("https://new.example.invalid/v1")
        expect(Config.latest(entries, "providers")?.openai.models).toBeUndefined()
        expect(Config.latest(entries, "providers")?.openai.filter?.allow).toEqual([])
        expect(Config.latest(entries, "provider_filter")?.deny).toEqual(["openai"])
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("failed activation cannot publish a configured model and releases the writer lock", () =>
  Effect.acquireUseRelease(
    Effect.promise(tmpdir),
    (tmp) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const file = path.join(tmp.path, "zaovra.jsonc")
        yield* Effect.promise(() => Bun.write(file, original))
        let fail = true
        const wrapped = FSUtil.Service.of({
          ...fs,
          writeFileString: (target, text, options) => {
            if (target !== file || !fail) return fs.writeFileString(target, text, options)
            fail = false
            return fs.writeFileString(path.join(tmp.path, "missing", "config"), text, options)
          },
        })
        const service = yield* config(tmp.path, tmp.path, wrapped)
        yield* service.activateModels!(["openai"])
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(original)
        expect(Config.latest(yield* service.entries(), "providers")?.openai.models).toBeUndefined()
        const saved = yield* ConfigFile.update(wrapped, file, (text) => Effect.succeed(text + "\n// next writer"))
        expect(saved.changed).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toContain("// next writer")
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("interruption releases the canonical-path writer lock", () =>
  Effect.acquireUseRelease(
    Effect.promise(tmpdir),
    (tmp) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const file = path.join(tmp.path, "zaovra.jsonc")
        yield* Effect.promise(() => Bun.write(file, original))
        const entered = yield* Deferred.make<void>()
        const pending = yield* ConfigFile.update(fs, file, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(pending)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(original)
        const saved = yield* ConfigFile.update(fs, path.join(tmp.path, ".", "zaovra.jsonc"), (text) =>
          Effect.succeed(text + "\n// after interruption"),
        )
        expect(saved.changed).toBe(true)
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("a completed external edit fails explicitly instead of acknowledging a stale Settings save", () =>
  Effect.acquireUseRelease(
    Effect.promise(tmpdir),
    (tmp) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const file = path.join(tmp.path, "zaovra.jsonc")
        yield* Effect.promise(() => Bun.write(file, original))
        const newer = original + "\n// editor changed"
        const result = yield* ConfigFile.update(fs, file, (text) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => Bun.write(file, newer))
            return text + "\n// stale patch"
          }),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(newer)
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("different processes and profile state directories still coordinate the same config file", () =>
  Effect.acquireUseRelease(
    Effect.promise(tmpdir),
    (tmp) =>
      Effect.gen(function* () {
        const file = path.join(tmp.path, "zaovra.jsonc")
        yield* Effect.promise(() => Bun.write(file, original))
        const children = ["writerA", "writerB"].map((field) =>
          Bun.spawn(
            [process.execPath, "run", path.join(import.meta.dir, "../fixture/config-writer718.ts"), file, field],
            {
              cwd: path.join(import.meta.dir, "../.."),
              env: { ...process.env, XDG_STATE_HOME: path.join(tmp.path, field) },
              stdout: "pipe",
              stderr: "pipe",
            },
          ),
        )
        const results = yield* Effect.promise(() =>
          Promise.all(
            children.map(async (child) => {
              const [exit, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
              ])
              return { exit, stdout, stderr }
            }),
          ),
        )
        expect(results.map((result) => result.exit)).toEqual([0, 0])
        expect(results.every((result) => result.stdout.includes("writer718-exited:"))).toBe(true)
        expect(results.map((result) => result.stderr)).toEqual(["", ""])
        const text = yield* Effect.promise(() => Bun.file(file).text())
        expect(parse(text).writerA).toBe(true)
        expect(parse(text).writerB).toBe(true)
        expect(text).toContain("// keep comment")
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
