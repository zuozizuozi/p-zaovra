import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import type { ZaovraClient } from "@zaovra-ai/sdk/v2/client"

const state = { locale: "zh", fail: false, readOnly: false, saves: 0, commands: 0 }
const language = { locale: () => state.locale, t: (key: string) => key }
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/platform", () => ({ usePlatform: () => ({}) }))
const { CustomizationPage } = await import("../../src/components/customization-page")
const disposals: Array<() => void> = []
const client = {
  v2: {
    customization: {
      list: async () => {
        if (state.fail) throw new Error("offline")
        return {
          data: { data: { mcpEditable: !state.readOnly, skillsEditable: !state.readOnly, mcp: [], skills: [] } },
        }
      },
      saveMcp: async () => {
        state.saves++
        throw new Error("Save failed; keep your inputs")
      },
    },
    command: { list: async () => ({ data: { data: [] } }) },
  },
} as unknown as ZaovraClient
const settle = () => Bun.sleep(40)
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text)!
const change = (name: string, value: string) => {
  const node = document.querySelector<HTMLInputElement>(`[name="${name}"]`)!
  node.value = value
  node.dispatchEvent(new Event("input", { bubbles: true }))
}
function mount(directory = "F:/synthetic766") {
  const node = document.createElement("main")
  document.body.append(node)
  const dispose = render(
    () => (
      <I18nProvider value={language}>
        <CustomizationPage
          client={client}
          directory={directory}
          onClose={() => {}}
          onCommands={() => {
            state.commands++
          }}
        />
      </I18nProvider>
    ),
    node,
  )
  disposals.push(dispose)
  return dispose
}
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  Object.assign(state, { locale: "zh", fail: false, readOnly: false, saves: 0, commands: 0 })
})
for (const locale of ["zh", "en"])
  test(`766 ${locale} customization has real management controls and protects injected configuration`, async () => {
    state.locale = locale
    state.readOnly = true
    mount()
    await settle()
    expect(document.querySelector("h1")?.textContent).toBe(locale === "zh" ? "自定义" : "Customize")
    expect(button(locale === "zh" ? "添加MCP" : "Add MCP").disabled).toBe(true)
    expect(document.querySelector("form")).toBeNull()
    expect(state.saves).toBe(0)
  })
test("766 bad advanced JSON and server failure retain the editable add form", async () => {
  mount()
  await settle()
  button("添加MCP").click()
  change("mcp-name", "fixture")
  change("mcp-url", "https://fixture.invalid/mcp")
  change("mcp-advanced", '{"bad":123}')
  button("添加").click()
  await settle()
  expect(document.body.textContent).toContain("JSON对象")
  expect(
    document.querySelector('[role="alert"]')?.textContent ??
      "no alert; saves=" + state.saves + "; form=" + document.querySelector("form")?.checkValidity(),
  ).toContain("JSON")
  expect(state.saves).toBe(0)
  expect(document.querySelector<HTMLInputElement>('[name="mcp-name"]')?.value).toBe("fixture")
  change("mcp-advanced", "{}")
  button("添加").click()
  button("添加").click()
  await settle()
  expect(state.saves).toBe(1)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("keep your inputs")
  expect(document.querySelector<HTMLInputElement>('[name="mcp-url"]')?.value).toBe("https://fixture.invalid/mcp")
})
test("766 failed list can retry without throwing through the application view", async () => {
  state.fail = true
  mount()
  await settle()
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  expect(document.querySelector("h1")?.textContent).toBe("自定义")
  state.fail = false
  button("刷新").click()
  await settle()
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(button("添加MCP").disabled).toBe(false)
})
test("766 no project has no management request or invented placeholder entries", async () => {
  mount("")
  await settle()
  expect(state.commands).toBe(0)
  expect(document.querySelector("nav")).toBeNull()
  expect(document.body.textContent).toContain("请选择项目")
})
