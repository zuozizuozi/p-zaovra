import { expect, test } from "bun:test"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { dict } from "../../../ui/src/i18n/zh"
const app = await import("../../src/i18n/zh")
import { ToolErrorCard, toolFailureMessage } from "../../../session-ui/src/components/tool-error-card"
import { SessionEndBar, budgetAttention } from "../../src/pages/session/composer/session-end-bar"

const dictionary: Record<string, string> = { ...dict, ...app.dict }
const value = {
  locale: () => "zh",
  t: (key: string, params?: Record<string, string | number | boolean>) =>
    (dictionary[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name) => String(params?.[name] ?? "")),
}

test("an uneventful turn has no footer, including checks without changes and budget below 80%", () => {
  const host = document.createElement("main")
  document.body.append(host)
  const [state, set] = createStore({ changes: false, notice: undefined as string | undefined })
  let undos = 0
  const dispose = render(
    () => (
      <I18nProvider value={value}>
        <SessionEndBar
          hasChanges={state.changes}
          passed={3}
          notice={state.notice}
          changes={<button>2 个文件已更改 +8 −2</button>}
          onUndo={() => undos++}
        >
          <p>原始检查结果</p>
        </SessionEndBar>
      </I18nProvider>
    ),
    host,
  )
  expect(host.textContent).toBe("")
  expect(budgetAttention({ used: { tokens: 79, durationMs: 0 }, limits: { tokens: 100 } })).toBe(false)
  expect(budgetAttention({ used: { tokens: 80, durationMs: 0 }, limits: { tokens: 100 } })).toBe(true)
  expect(budgetAttention(undefined, true)).toBe(true)
  set("changes", true)
  expect(host.querySelectorAll("[data-component=session-end-bar]").length).toBe(1)
  expect(host.textContent).toContain("已检查 3 项")
  expect(host.textContent).not.toContain("暂无有效检查")
  const row = host.firstElementChild!
  expect(row.classList.contains("flex-wrap")).toBe(false)
  expect(row.classList.contains("h-7")).toBe(true)
  Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent === "撤销")!
    .click()
  expect(undos).toBe(1)
  set("notice", "检查没有通过，请修复后重新检查。")
  expect(host.querySelectorAll("[data-component=session-end-bar]").length).toBe(1)
  expect(host.textContent).toContain("检查没有通过")
  expect(host.textContent).not.toContain("本轮已结束")
  dispose()
  host.remove()
})

test("tool failure is amber with a useful next action; permission abort retains red and raw bytes remain expandable", async () => {
  const host = document.createElement("main")
  document.body.append(host)
  const [card, setCard] = createStore({ open: false })
  const original = "Unable to read missing.html\nENOENT internal diagnostic"
  const dispose = render(
    () => (
      <I18nProvider value={value}>
        <ToolErrorCard
          open={card.open}
          onOpenChange={(open) => setCard("open", open)}
          tool="read"
          error={original}
          input={{ path: "missing.html" }}
          metadata={{ readFailure: "not_found" }}
        />
        <ToolErrorCard
          tool="read"
          error="PermissionV2.BlockedError"
          input={{ path: "private.txt" }}
          metadata={{ phase: "permission", reason: "PermissionV2.BlockedError" }}
        />
      </I18nProvider>
    ),
    host,
  )
  const cards = host.querySelectorAll("[data-kind=tool-error-card]")
  expect(cards[0]?.getAttribute("data-variant")).toBe("warning")
  expect(cards[1]?.getAttribute("data-variant")).toBe("error")
  expect(cards[0]?.textContent).toContain("没有找到 missing.html")
  expect(cards[0]?.textContent).toContain("你可以提供这个文件")
  expect(cards[0]?.textContent).not.toContain("Unable to read")
  setCard("open", true)
  await Promise.resolve()
  expect(cards[0]?.textContent).toContain(original)
  expect(toolFailureMessage({ tool: "bash", error: "exit 1" }).key).toBe("ui.toolErrorCard.commandAction")
  expect(
    toolFailureMessage({
      tool: "read",
      input: { path: "x" },
      error: "Unable to read x",
      metadata: { readFailure: "unknown" },
    }).key,
  ).toBe("ui.toolErrorCard.readAction")
  expect(toolFailureMessage({ error: "opaque diagnostic" }).key).toBe("ui.toolErrorCard.actionable")
  dispose()
})

test("an executed browser action with a failed screenshot asks to inspect the scene before the filesystem cause", () => {
  for (const cause of ["EACCES: access denied", "ENOENT: no such file"]) {
    const error = `Outcome may have occurred; observe before retrying: ${cause}`
    const message = toolFailureMessage({
      tool: "browser",
      error,
      metadata: { phase: "execution", reason: "output-unconfirmed" },
    })
    expect(message.key).toBe("ui.toolErrorCard.uncertainAction")
    expect(message.critical).toBe(false)
  }
  expect(toolFailureMessage({ tool: "browser", error: "ENOENT", metadata: { reason: "output-unconfirmed" } }).key).toBe(
    "ui.toolErrorCard.uncertainAction",
  )
  expect(toolFailureMessage({ tool: "read", error: "ENOENT: no such file" }).key).toBe("ui.toolErrorCard.missingAction")
  expect(toolFailureMessage({ tool: "read", error: "EACCES: access denied" }).key).toBe(
    "ui.toolErrorCard.permissionAction",
  )
})
