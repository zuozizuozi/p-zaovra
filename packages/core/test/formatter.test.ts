import { expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Formatter } from "../src/formatter"
import { LayerNode } from "../src/effect/layer-node"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

it.live("executes configured formatters in order and reports failed commands", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const file = path.join(tmp.path, "sample.audit")
    yield* Effect.promise(() => Bun.write(file, "initial"))
    yield* Effect.promise(() =>
      Bun.write(
        path.join(tmp.path, "zaovra.json"),
        JSON.stringify({
          formatter: {
            first: {
              extensions: [".audit"],
              command: [
                process.execPath,
                "-e",
                "require('fs').appendFileSync(process.argv[1], process.env.AUDIT_SUFFIX)",
                "$FILE",
              ],
              environment: { AUDIT_SUFFIX: "A" },
            },
            failing: { extensions: [".audit"], command: [process.execPath, "-e", "process.exit(2)"] },
            missing: { extensions: [".audit"], command: ["zaovra-nonexistent-test-formatter"] },
            second: {
              extensions: [".audit"],
              command: [process.execPath, "-e", "require('fs').appendFileSync(process.argv[1], 'B')", "$FILE"],
            },
          },
        }),
      ),
    )
    yield* Effect.gen(function* () {
      const formatter = yield* Formatter.Service
      expect(yield* formatter.format(file)).toEqual({ ran: ["first", "second"], failed: ["failing", "missing"] })
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("initialAB")
      expect(yield* formatter.format(path.join(tmp.path, "ignored.unknown"))).toEqual({ ran: [], failed: [] })
    }).pipe(
      Effect.provide(
        LayerNode.compile(Formatter.node, [
          [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
        ]),
      ),
    )
  }),
)

it.live("uses the project's installed Prettier and formatting configuration", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const filesystem = yield* Effect.promise(() => import("fs/promises"))
    yield* Effect.promise(() =>
      filesystem.symlink(
        path.resolve(import.meta.dirname, "../../../node_modules"),
        path.join(tmp.path, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      ),
    )
    yield* Effect.promise(() =>
      Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ devDependencies: { prettier: "*" } })),
    )
    yield* Effect.promise(() =>
      Bun.write(path.join(tmp.path, ".prettierrc"), JSON.stringify({ semi: false, singleQuote: true })),
    )
    yield* Effect.promise(() =>
      Bun.write(path.join(tmp.path, "zaovra.json"), JSON.stringify({ formatter: { prettier: {} } })),
    )
    const file = path.join(tmp.path, "example.js")
    yield* Effect.promise(() => Bun.write(file, 'const answer={ text: "hello" };'))
    yield* Effect.gen(function* () {
      const formatter = yield* Formatter.Service
      expect(yield* formatter.format(file)).toEqual({ ran: ["prettier"], failed: [] })
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("const answer = { text: 'hello' }\n")
    }).pipe(
      Effect.provide(
        LayerNode.compile(Formatter.node, [
          [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
        ]),
      ),
    )
  }),
)
