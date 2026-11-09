import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"

const root = process.env.ZAOVRA_SERVER_TEST_DIR
if (!root || !path.isAbsolute(root)) throw new Error("Use an isolated absolute ZAOVRA_SERVER_TEST_DIR")
for (const [key, directory] of Object.entries({
  HOME: "home",
  USERPROFILE: "home",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state",
  TEMP: "temp",
  TMP: "temp",
  TMPDIR: "temp",
})) {
  process.env[key] = path.join(root, directory)
  await fs.mkdir(process.env[key]!, { recursive: true })
}
process.env.ZAOVRA_TEST_HOME = path.join(root, "home")
process.env.ZAOVRA_DISABLE_MODELS_FETCH = "true"
process.env.ZAOVRA_CONFIG_CONTENT = "{}"
process.env.ZAOVRA_DB = ":memory:"
const { createEmbeddedRoutes } = await import("./routes")
const { Global } = await import("@zaovra-ai/core/global")
const { Layer } = await import("effect")
const { HttpRouter, HttpServer } = await import("effect/unstable/http")

test("784 production routes provide global request services to customization writes", async () => {
  const project = path.join(root!, "project")
  await fs.mkdir(project, { recursive: true })
  const web = HttpRouter.toWebHandler(createEmbeddedRoutes().pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => web.handler(request) })
  const url = (suffix = "") =>
    new URL("/api/customization" + suffix + "?location%5Bdirectory%5D=" + encodeURIComponent(project), server.url)
  const write = (suffix: string, payload: unknown) =>
    fetch(url(suffix), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
  try {
    const saved = await write("/mcp/isolated784", {
      config: { type: "local", command: ["never-started784"], disabled: true },
    })
    expect(saved.status, await saved.text()).toBe(204)
    const config = await Bun.file(path.join(Global.Path.config, "zaovra.jsonc")).json()
    expect(config.mcp.servers.isolated784.command).toEqual(["never-started784"])
    expect(config.mcp.servers.isolated784.disabled).toBe(true)
    const listed = await fetch(url())
    expect(listed.status, await listed.clone().text()).toBe(200)
    expect(
      (await listed.json()).data.mcp.some(
        (entry: { name: string; disabled: boolean }) => entry.name === "isolated784" && entry.disabled,
      ),
    ).toBe(true)
    const removed = await fetch(url("/mcp/isolated784"), { method: "DELETE" })
    expect(removed.status, await removed.text()).toBe(204)
    expect(
      (await Bun.file(path.join(Global.Path.config, "zaovra.jsonc")).json()).mcp.servers.isolated784,
    ).toBeUndefined()
  } finally {
    await server.stop(true)
    await web.dispose()
  }
}, 30000)
