import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { readFile } from "node:fs/promises"
import { PreviewProcess } from "../src/preview-process"
import { tmpdir } from "./fixture/tmpdir"

test("479 real Node preview launches, queries, refuses stale ownership and cancels", async () => {
  await using tmp = await tmpdir()
  const output = path.join(tmp.path, "preview-node.mjs")
  const bundler = Bun.resolveSync(
    "esbuild",
    path.dirname(Bun.resolveSync("vite", path.resolve(import.meta.dir, "../../app-ui"))),
  )
  const { build, stop } = await import(pathToFileURL(bundler).href)
  const result = await build({
    entryPoints: [path.join(import.meta.dir, "preview-process.node.ts")],
    platform: "node",
    format: "esm",
    bundle: true,
    metafile: true,
    outfile: output,
    plugins: [
      {
        name: "node-runtime-dependencies",
        setup(build: {
          onResolve: (
            input: { filter: RegExp },
            handler: (args: { path: string; resolveDir: string }) => unknown,
          ) => void
        }) {
          build.onResolve({ filter: /^effect(?:\/|$)/ }, (args) => ({
            path: pathToFileURL(Bun.resolveSync(args.path, args.resolveDir)).href,
            external: true,
          }))
        },
      },
    ],
  })
  await stop()
  const inputs = Object.keys(result.metafile.inputs)
  expect(inputs.some((file) => file.endsWith("preview-native.node.ts"))).toBe(true)
  expect(inputs.some((file) => file.endsWith("preview-native.bun.ts"))).toBe(false)
  expect(await readFile(output, "utf8")).not.toContain("bun:ffi")
  const child = Bun.spawn(["node", output, tmp.path], { stdout: "pipe", stderr: "pipe", env: { ...process.env } })
  try {
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const exit = await child.exited
    expect(await stderr).toBe("")
    expect(exit).toBe(0)
    expect(await stdout).toContain('"businessClosed":true')
  } finally {
    child.kill()
    await child.exited
    await PreviewProcess.cancel({
      root: tmp.path,
      directory: tmp.path,
      sessionID: "node-session",
      jobID: "node-preview",
    })
  }
}, 60000)
