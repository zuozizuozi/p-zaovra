import { test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"

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
