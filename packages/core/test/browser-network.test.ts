import { test, expect } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

test("browser network authorization on the Desktop Node runtime", async () => {
  const output = path.join(tmpdir(), `browser-network-${process.pid}.mjs`)
  const bundler = Bun.resolveSync("esbuild", path.dirname(Bun.resolveSync("vite", path.resolve(import.meta.dir, "../../app-ui"))))
  const { build } = await import(pathToFileURL(bundler).href)
  await build({
    entryPoints: [path.join(import.meta.dir, "browser-network.node.ts")],
    bundle: true, platform: "node", format: "esm", outfile: output,
    plugins: [{ name: "playwright-runtime", setup(build: { onResolve: (options: { filter: RegExp }, handler: (args: { path: string; resolveDir: string }) => unknown) => void }) {
      build.onResolve({ filter: /^playwright-core$/ }, (args) => ({ path: pathToFileURL(Bun.resolveSync(args.path, args.resolveDir)).href, external: true }))
    } }],
  })
  const child = Bun.spawn(["node", output], { stdout: "inherit", stderr: "inherit", env: { ...Bun.env } })
  expect(await child.exited).toBe(0)
}, 90000)
