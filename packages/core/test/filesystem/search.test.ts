import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
// Load the public filesystem module first, matching the production import order.
import "@zaovra-ai/core/filesystem"
import { FileSystemSearch } from "@zaovra-ai/core/filesystem/search"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { Location } from "@zaovra-ai/core/location"
import { location } from "../fixture/location"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Ripgrep } from "@zaovra-ai/core/ripgrep"
import { AbsolutePath, RelativePath } from "@zaovra-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Ripgrep.node, FSUtil.node])))

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }),
    ),
  )

  it.live("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )
})

// Exercise the real background index, including shared parents and sibling prefixes.
it.live("indexes each discovered directory once while retaining all files", () =>
  withTmp((directory) =>
    Effect.gen(function* () {
      const names = Array.from({ length: 32 }, (_, index) => `group-${index}/nested`)
      yield* Effect.promise(() =>
        Promise.all(
          names.map(async (name) => {
            await fs.mkdir(path.join(directory, name), { recursive: true })
            await Promise.all(
              Array.from({ length: 8 }, (_, index) =>
                fs.writeFile(path.join(directory, name, `file-${index}.txt`), "index"),
              ),
            )
          }),
        ),
      )
      yield* Effect.gen(function* () {
        const search = yield* FileSystemSearch.Service
        yield* search.find({ query: "file", type: "file", limit: 300 }).pipe(
          Effect.tap(() => Effect.sleep("10 millis")),
          Effect.repeat({ while: (files) => files.length !== 256 }),
          Effect.timeout("10 seconds"),
        )
        const directories = yield* search.find({ query: "group", type: "directory", limit: 100 })
        expect(directories.map((entry) => entry.path).sort()).toEqual(
          names
            .flatMap((name) => [RelativePath.make(name.split("/")[0] + path.sep), RelativePath.make(name + path.sep)])
            .sort(),
        )
        expect(new Set(directories.map((entry) => entry.path)).size).toBe(64)
        expect((yield* search.find({ query: "file", type: "file", limit: 300 })).length).toBe(256)
      }).pipe(
        Effect.provide(FileSystemSearch.ripgrepLayer),
        Effect.provideService(Location.Service, location({ directory })),
      )
    }),
  ),
)
