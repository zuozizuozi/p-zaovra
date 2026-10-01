import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { BrowserTool } from "../src/tool/browser"
import { Tools } from "../src/tool/tools"
import { ToolRegistry } from "../src/tool/registry"
import { PermissionV2 } from "../src/permission"
import { Catalog } from "../src/catalog"
import { SessionStore } from "../src/session/store"
import { ToolOutputStore } from "../src/tool-output-store"

test.skipIf(process.platform !== "win32")("does not register browser in Windows Bun", async () => {
  let registered = false
  await Effect.runPromise(
    BrowserTool.Service.pipe(
      Effect.provide(
        AppNodeBuilder.build(BrowserTool.node, [
          [
            ToolRegistry.node,
            Layer.mock(Tools.Service, {
              register: () =>
                Effect.sync(() => {
                  registered = true
                }),
            }),
          ],
          [PermissionV2.node, Layer.empty],
          [Catalog.node, Layer.empty],
          [SessionStore.node, Layer.empty],
          [ToolOutputStore.node, Layer.empty],
        ]),
      ),
    ),
  )
  expect(registered).toBe(false)
})

test("browser integration on the Desktop Node runtime", async () => {
  const output = path.join(tmpdir(), `browser-integration-${process.pid}.mjs`)
  const bundler = Bun.resolveSync(
    "esbuild",
    path.dirname(Bun.resolveSync("vite", path.resolve(import.meta.dir, "../../app-ui"))),
  )
  const { build } = await import(pathToFileURL(bundler).href)
  await build({
    entryPoints: [path.join(import.meta.dir, "tool-browser.node.ts")],
    platform: "node",
    format: "esm",
    bundle: true,
    splitting: true,
    outdir: path.dirname(output),
    entryNames: path.basename(output, ".mjs"),
    outExtension: { ".js": ".mjs" },
    loader: { ".wasm": "file", ".node": "file", ".md": "text" },
    banner: { js: 'var require = (await import("node:module")).createRequire(import.meta.url);' },
    plugins: [
      {
        name: "runtime-packages",
        setup(build: {
          onLoad: (options: { filter: RegExp }, handler: (args: { path: string }) => unknown) => void
          onResolve: (
            options: { filter: RegExp },
            handler: (args: { path: string; resolveDir: string }) => unknown,
          ) => void
        }) {
          build.onResolve({ filter: /^jsonc-parser$/ }, (args) => ({
            path: Bun.resolveSync(args.path, args.resolveDir).replace(/lib[\\/]umd[\\/]main.js$/, "lib/esm/main.js"),
          }))
          build.onLoad({ filter: /(?:photon|skill)\.ts$/ }, async (args) => ({
            contents: (await Bun.file(args.path).text()).replace(/ with \{ type: "(?:text|file)" \}/g, ""),
            loader: "ts",
          }))
          build.onResolve({ filter: /^(effect(?:\/|$)|@effect\/|playwright-core$)/ }, (args) => ({
            path: pathToFileURL(Bun.resolveSync(args.path, args.resolveDir)).href,
            external: true,
          }))
        },
      },
    ],
  })
  const child = Bun.spawn(["node", output], { stdout: "inherit", stderr: "inherit", env: { ...Bun.env } })
  if ((await child.exited) !== 0) throw new Error("Node browser integration failed")
}, 60000)
