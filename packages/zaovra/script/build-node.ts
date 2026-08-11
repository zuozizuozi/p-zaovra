#!/usr/bin/env bun

import fs from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const outdir = path.join(root, "dist", "node")

if (!outdir.startsWith(path.join(root, "dist") + path.sep)) throw new Error(`Invalid server bundle target: ${outdir}`)

await fs.rm(outdir, { recursive: true, force: true })
process.chdir(root)

const result = await Bun.build({
  entrypoints: [path.join(root, "src", "server", "server.ts")],
  outdir,
  target: "node",
  format: "esm",
  splitting: true,
  external: ["node-gyp"],
  naming: {
    entry: "node.js",
    chunk: "[name]-[hash].[ext]",
    asset: "[name]-[hash].[ext]",
  },
})

if (result.success) {
  await Bun.write(path.join(outdir, "zaovra-web-ui.gen.ts"), "export default null\n")
  process.exit(0)
}
result.logs.forEach((log) => console.error(log))
process.exit(1)
