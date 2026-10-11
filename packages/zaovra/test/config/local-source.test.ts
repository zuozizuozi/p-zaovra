import { test, expect } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ConfigPlugin } from "@/config/plugin"
import { tmpdir } from "../fixture/fixture"

test("only actual custom tool or plugin source enables SDK installation", async () => {
  await using dir = await tmpdir()
  expect(await ConfigPlugin.hasLocalSource(dir.path)).toBe(false)
  await Bun.write(path.join(dir.path, "zaovra.json"), "{}")
  await Bun.write(path.join(dir.path, "plugins/readme.md"), "not source")
  expect(await ConfigPlugin.hasLocalSource(dir.path)).toBe(false)
  await Bun.write(path.join(dir.path, "tools/custom.ts"), "export default {}")
  expect(await ConfigPlugin.hasLocalSource(dir.path)).toBe(true)
})

test("explicit local source inside the config directory is preserved", async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "custom.mjs")
  const origin = {
    spec: pathToFileURL(file).href,
    source: path.join(dir.path, "zaovra.json"),
    scope: "global" as const,
  }
  expect(await ConfigPlugin.hasLocalSource(dir.path, [origin])).toBe(false)
  await Bun.write(file, "export default {}")
  expect(await ConfigPlugin.hasLocalSource(dir.path, [origin])).toBe(true)
  expect(await ConfigPlugin.hasLocalSource(path.join(dir.path, "other"), [origin])).toBe(false)
})
