import { describe, expect, test } from "bun:test"

const file = new URL("../../src/plugin/index.ts", import.meta.url)

describe("plugin legacy auth isolation", () => {
  test("strips legacy auth hooks at every registration boundary", async () => {
    const src = await Bun.file(file).text()
    expect(src).toContain("withoutLegacyAuth")
    expect(src).toContain("hooks.push(withoutLegacyAuth(init.value))")
    expect(src).toContain("withoutLegacyAuth(await (plugin as PluginModule).server")
    expect(src).toContain("withoutLegacyAuth(await server")
  })

  test("config hooks are individually error-isolated in the layer factory", async () => {
    const src = await Bun.file(file).text()
    expect(src).toContain("plugin config hook failed")
    const pattern =
      /for\s*\(const hook of hooks\)\s*\{[\s\S]*?Effect\.tryPromise[\s\S]*?\.config\?\.\([\s\S]*?plugin config hook failed[\s\S]*?Effect\.ignore/
    expect(pattern.test(src)).toBe(true)
  })
})
