import { expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { render } from "solid-js/web"
import { createZaovraClient, type CommandView } from "@zaovra-ai/sdk/v2/client"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { dict } from "../../../ui/src/i18n/zh"
import { request } from "./native-fetch766"

const root = process.env.ZAOVRA_766_TEST_ROOT
if (!root || !path.isAbsolute(root)) throw new Error("An isolated absolute test root is required")
const language = { locale: () => "zh", t: (key: string) => dict[key as keyof typeof dict] ?? key }
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    openLink: () => {
      throw new Error("No browser interaction in this fixture")
    },
  }),
}))
const { CustomizationPage } = await import("../../src/components/customization-page")
const source = path.resolve(import.meta.dir, "../../../..")
const project = path.join(root, "project")
const configDir = path.join(root, "config")
const configFile = path.join(configDir, "zaovra.jsonc")
const mcpLog = path.join(root, "mcp.ndjson")
let commands: CommandView[] = []
let mounted: (() => void) | undefined
const pause = () => Bun.sleep(40)
async function until(check: () => boolean | Promise<boolean>, note: string) {
  for (let n = 0; n < 500; n++) {
    if (await check()) return
    await pause()
  }
  throw new Error("Timed out: " + note + "; page=" + document.body.textContent?.slice(-1200))
}
function button(text: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text,
  )
  if (!node) throw new Error("Missing button " + text)
  return node
}
function input(name: string, value: string) {
  const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`)!
  node.value = value
  node.dispatchEvent(new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }))
}
function mount(client: ReturnType<typeof createZaovraClient>) {
  mounted?.()
  document.body.replaceChildren()
  commands = []
  const node = document.createElement("main")
  document.body.append(node)
  mounted = render(
    () => (
      <I18nProvider value={language}>
        <CustomizationPage
          client={client}
          directory={project}
          onClose={() => {}}
          onCommands={(value) => {
            commands = value
          }}
        />
      </I18nProvider>
    ),
    node,
  )
}
async function start(index: number | string) {
  const runtime = path.join(root, "runtime-" + index)
  await fs.mkdir(path.join(root, "temp"), { recursive: true })
  await fs.mkdir(runtime, { recursive: true })
  const env: Record<string, string> = Object.fromEntries(
    ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]!]] : [],
    ),
  )
  Object.assign(env, {
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    ZAOVRA_CONFIG_DIR: configDir,
    ZAOVRA_TEST_HOME: path.join(root, "home"),
    ZAOVRA_DB: ":memory:",
    ZAOVRA_MODELS_PATH: path.join(source, "packages/core/test/plugin/fixtures/models-dev.json"),
    ZAOVRA_DISABLE_MODELS_FETCH: "true",
    TEMP: path.join(root, "temp"),
    TMP: path.join(root, "temp"),
    TMPDIR: path.join(root, "temp"),
    ZAOVRA_766_TEST_ROOT: runtime,
  })
  const child = Bun.spawn(
    [process.execPath, path.join(source, "packages/server/src/fixtures/customization766-server.ts")],
    { cwd: project, env, stdout: "pipe", stderr: "pipe" },
  )
  const out = new Response(child.stdout).text()
  const err = new Response(child.stderr).text()
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error("HTTP fixture exited: " + child.exitCode + "\n" + (await err))
      return Bun.file(path.join(runtime, "listening.json")).exists()
    }, "HTTP fixture listener")
  } catch (error) {
    child.kill()
    await child.exited
    await fs.writeFile(path.join(runtime, "stdout.log"), await out)
    await fs.writeFile(path.join(runtime, "stderr.log"), await err)
    throw error
  }
  const { url } = (await Bun.file(path.join(runtime, "listening.json")).json()) as { url: string }
  const client = createZaovraClient({ baseUrl: url, fetch: request, throwOnError: true })
  let closed = false
  const stop = async () => {
    if (closed) return
    closed = true
    mounted?.()
    mounted = undefined
    document.body.replaceChildren()
    await request(new URL("/__766/stop", url), { method: "POST" })
    const exit = await Promise.race([
      child.exited,
      Bun.sleep(15000).then(() => {
        throw new Error("Backend did not exit")
      }),
    ])
    await fs.writeFile(path.join(runtime, "stdout.log"), await out)
    await fs.writeFile(path.join(runtime, "stderr.log"), await err)
    expect(exit).toBe(0)
    expect(await Bun.file(path.join(runtime, "stopped.json")).exists()).toBe(true)
  }
  return { client, stop }
}
test("766 actual Solid page → generated SDK → real HTTP → config writer → MCP, five rebuild rounds", async () => {
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(path.join(project, ".zaovra/skills/review766"), { recursive: true })
  await Bun.write(configFile, '// preserve me\n{"theme":"system","permission":{"*":"allow"}}')
  await Bun.write(
    path.join(project, ".zaovra/skills/review766/SKILL.md"),
    "---\nname: review766\ndescription: Fixture skill\n---\nLiteral skill $1 $ARGUMENTS",
  )
  for (let round = 0; round < 5; round++) {
    let backend = await start(round)
    try {
      mount(backend.client)
      await until(
        () =>
          !!document.querySelector('[data-component="customization-page"]') &&
          commands.some((item) => item.name === "skill:review766"),
        "actual discovered skill",
      )
      const list = await backend.client.v2.customization.list(
        { location: { directory: project } },
        { throwOnError: true },
      )
      expect(list.data.data.skills.find((item) => item.name === "review766")?.disabled).toBe(false)
      expect(document.querySelector("[data-mcp-name]")).toBeNull()
      button("添加MCP").click()
      input("mcp-name", "local766")
      input("mcp-type", "local")
      input("mcp-program", process.execPath)
      input("mcp-args", path.join(source, "packages/core/test/fixture/customization766-mcp.ts"))
      input("mcp-advanced", JSON.stringify({ ZAOVRA_766_MCP_LOG: mcpLog }))
      button("添加").click()
      await until(
        () =>
          !!document.querySelector('[data-mcp-name="local766"]') &&
          commands.some((item) => item.name === "mcp:local766:review"),
        "persisted MCP and real prompt",
      )
      expect(
        JSON.parse((await Bun.file(configFile).text()).replace(/^\/\/[^\n]*\n/, "")).mcp.servers.local766.type,
      ).toBe("local")
      const result = await backend.client.v2.command.render(
        { name: "mcp:local766:review", arguments: "target " + round, agent: "build", location: { directory: project } },
        { throwOnError: true },
      )
      expect(result.data.data.template).toContain("target " + round)
      expect(result.data.data.template).toContain("$1 $ARGUMENTS")
      const skill = await backend.client.v2.command.render(
        { name: "skill:review766", arguments: "extra", agent: "build", location: { directory: project } },
        { throwOnError: true },
      )
      expect(skill.data.data.template).toContain("Literal skill $1 $ARGUMENTS")
      document.querySelector<HTMLInputElement>('[data-mcp-name="local766"] input[type="checkbox"]')!.click()
      await until(
        () =>
          !commands.some((item) => item.source === "mcp") &&
          !document.querySelector<HTMLInputElement>('[data-mcp-name="local766"] input')!.checked,
        "disabled MCP removed from slash",
      )
      expect(
        JSON.parse((await Bun.file(configFile).text()).replace(/^\/\/[^\n]*\n/, "")).mcp.servers.local766.disabled,
      ).toBe(true)
      await backend.stop()
      backend = await start(round + "-saved")
      mount(backend.client)
      await until(
        () =>
          !!document.querySelector('[data-mcp-name="local766"] input') &&
          commands.some((item) => item.name === "skill:review766"),
        "restarted backend and reopened management",
      )
      expect(document.querySelector<HTMLInputElement>('[data-mcp-name="local766"] input')!.checked).toBe(false)
      document.querySelector<HTMLInputElement>('[data-mcp-name="local766"] input')!.click()
      await until(() => commands.some((item) => item.source === "mcp"), "MCP enabled again")
      button("技能").click()
      document.querySelector<HTMLInputElement>('[data-skill-name="review766"] input')!.click()
      await until(
        () =>
          !commands.some((item) => item.name === "skill:review766") &&
          !document.querySelector<HTMLInputElement>('[data-skill-name="review766"] input')!.checked,
        "disabled skill removed from slash",
      )
      const denied = await backend.client.v2.command.render(
        { name: "skill:review766", arguments: "", agent: "build", location: { directory: project } },
        { throwOnError: false },
      )
      expect(denied.response.status).toBe(400)
      document.querySelector<HTMLInputElement>('[data-skill-name="review766"] input')!.click()
      await until(() => commands.some((item) => item.name === "skill:review766"), "skill enabled again")
      button("MCP").click()
      button("删除").click()
      button("确认删除").click()
      await until(
        () => !document.querySelector('[data-mcp-name="local766"]') && !commands.some((item) => item.source === "mcp"),
        "MCP removed from disk and slash",
      )
      expect(await Bun.file(configFile).text()).toContain("// preserve me")
    } finally {
      await backend.stop()
    }
  }
  const events = (await Bun.file(mcpLog).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string })
  expect(events.filter((item) => item.event === "getPrompt").length).toBeGreaterThanOrEqual(5)
  expect(events.filter((item) => item.event === "started").length).toBeGreaterThanOrEqual(10)
  console.log(
    JSON.stringify({
      rounds: 5,
      actualHttp: true,
      actualMcpProtocol: true,
      actualModels: 0,
      nativeOrBrowserInteraction: false,
      mcpEvents: events.length,
    }),
  )
}, 180000)
