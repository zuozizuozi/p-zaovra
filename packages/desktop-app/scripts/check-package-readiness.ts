#!/usr/bin/env bun

import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const required = [
  "out/main/index.js",
  "out/main/sidecar.js",
  "out/preload/index.js",
  "out/renderer/index.html",
  "resources/icons/icon.icns",
  "resources/icons/icon.ico",
  "resources/icons/icon.png",
  "resources/entitlements.plist",
]

const missing = (
  await Promise.all(
    required.map(async (file) => ({
      file,
      exists: await Bun.file(path.join(root, file)).exists(),
    })),
  )
).filter((item) => !item.exists)

if (missing.length > 0) {
  throw new Error(`Desktop package inputs are missing:\n${missing.map((item) => `- ${item.file}`).join("\n")}`)
}

const sidecar = await Bun.file(path.join(root, "out/main/sidecar.js")).text()
const serverChunk = sidecar.match(/import\("(\.\/chunks\/node-[^"]+\.js)"\)/)?.[1]
if (!serverChunk || !(await Bun.file(path.join(root, "out/main", serverChunk)).exists())) {
  throw new Error("Desktop sidecar does not reference an embedded Zaovra server chunk")
}

console.log(`Desktop package inputs ready (${required.length} files checked)`)
