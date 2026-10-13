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

test.each(["entry.ts", "entry.tsx", "package", "index-directory"])(
  "uses plugin resolver rules without executing %s",
  async (entry) => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, entry)
    const marker = path.join(dir.path, "executed")
    const source = `await Bun.write(${JSON.stringify(marker)}, "must not execute")`
    if (entry === "package") {
      await Bun.write(path.join(file, "package.json"), JSON.stringify({ main: "entry.tsx" }))
      await Bun.write(path.join(file, "entry.tsx"), source)
    } else if (entry === "index-directory") {
      await Bun.write(path.join(file, "index.tsx"), source)
    } else await Bun.write(file, source)
    const origin = { spec: `./${entry}`, source: path.join(dir.path, "zaovra.json"), scope: "local" as const }
    expect(await ConfigPlugin.hasLocalSource(dir.path, [origin])).toBe(true)
    expect(await Bun.file(marker).exists()).toBe(false)
  },
)

test("remote packages and empty configuration do not install local dependencies", async () => {
  await using dir = await tmpdir()
  expect(
    await ConfigPlugin.hasLocalSource(dir.path, [
      { spec: "remote-plugin@1.0.0", source: path.join(dir.path, "zaovra.json"), scope: "local" },
    ]),
  ).toBe(false)
  expect(await ConfigPlugin.hasLocalSource(dir.path)).toBe(false)
})
