import { expect } from "bun:test"
import { Effect } from "effect"
import { LSPRuntime } from "../src/lsp/runtime"
import { FSUtil } from "../src/fs-util"
import { AppProcess } from "../src/process"
import { LayerNode } from "../src/effect/layer-node"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"
import path from "path"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, AppProcess.node])))

it.live("drains installer output and prevents spawning after the runtime scope closes", () =>
  Effect.gen(function* () {
    const runtime = yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* LSPRuntime.make()
        const installer = runtime.process.spawn(
          [
            process.execPath,
            "-e",
            "process.stdout.write('x'.repeat(2_000_000)); process.stderr.write('y'.repeat(2_000_000))",
          ],
          { stdout: "pipe", stderr: "pipe" },
        )
        expect(yield* Effect.promise(() => installer.exited)).toBe(0)
        return runtime
      }),
    )
    expect(() => runtime.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"])).toThrow()
  }),
)

it.live("terminates an owned running process when its scope closes", () =>
  Effect.gen(function* () {
    const closed = yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* LSPRuntime.make()
        const child = runtime.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"])
        const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)))
        yield* Effect.promise(() => new Promise<void>((resolve) => child.once("spawn", () => resolve())))
        return closed
      }),
    )
    expect(yield* Effect.promise(() => closed)).not.toBe(0)
  }),
)

it.live("extracts archives with quoted paths and rejects invalid archives", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const runtime = yield* LSPRuntime.make()
    const source = path.join(tmp.path, "source's [file].txt")
    const archive = path.join(tmp.path, "archive's [file].zip")
    const destination = path.join(tmp.path, "output's [folder]")
    yield* Effect.promise(() => runtime.filesystem.writeStream(source, new Response("verified archive content").body!))
    yield* Effect.promise(() =>
      process.platform === "win32"
        ? runtime.process.run(
            [
              "powershell",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:ZAOVRA_LSP_TEST_SOURCE -DestinationPath $env:ZAOVRA_LSP_TEST_ZIP -Force",
            ],
            {
              env: { ZAOVRA_LSP_TEST_SOURCE: source, ZAOVRA_LSP_TEST_ZIP: archive },
            },
          )
        : runtime.process.run(["zip", "-j", archive, source]),
    )
    yield* Effect.promise(() => runtime.archive.extractZip(archive, destination))
    expect(yield* Effect.promise(() => Bun.file(path.join(destination, path.basename(source))).text())).toBe(
      "verified archive content",
    )
    yield* Effect.promise(() => Bun.write(archive, "invalid zip"))
    yield* Effect.promise(async () => {
      await expect(runtime.archive.extractZip(archive, destination)).rejects.toThrow()
    })
  }),
  15_000,
)
