#!/usr/bin/env bun

import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const outdir = path.join(root, "dist", "node")
const jsoncParserEsm = fileURLToPath(import.meta.resolve("jsonc-parser")).replace(
  path.join("lib", "umd", "main.js"),
  path.join("lib", "esm", "main.js"),
)
const modelsSnapshot = process.env.MODELS_DEV_API_JSON
  ? await Bun.file(process.env.MODELS_DEV_API_JSON).text()
  : await fetch(`${process.env.ZAOVRA_MODELS_URL || "https://models.dev"}/api.json`, {
      signal: AbortSignal.timeout(10_000),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`models.dev snapshot failed with HTTP ${response.status}`)
        return response.text()
      })
      .catch(() => Bun.file(path.join(root, "test", "tool", "fixtures", "models-api.json")).text())

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
  define: {
    ZAOVRA_MODELS_DEV: modelsSnapshot,
  },
  plugins: [
    {
      name: "jsonc-parser-esm",
      setup(build) {
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: jsoncParserEsm }))
      },
    },
  ],
})

if (result.success) {
  await Bun.write(path.join(outdir, "zaovra-web-ui.gen.ts"), "export default null\n")
  process.exit(0)
}
result.logs.forEach((log) => console.error(log))
process.exit(1)
