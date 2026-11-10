import { afterEach, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionMessage, SessionV2Info } from "@zaovra-ai/sdk/v2/client"
import { adaptSessionMessages } from "../../src/context/v2-session-adapter"
import { inspectTurnDeliverables, turnDeliverables } from "../../src/utils/turn-deliverables"
import { inspectArtifactFile } from "../../../desktop-app/src/main/artifact-save"

const [state, setState] = createStore({ directory: "", desktop: false, opened: true })
const reads: string[] = []
const platform = {
  artifactPreview: {
    inspectFile: (input: { target: string; directory: string }) => {
      reads.push(input.target)
      return inspectArtifactFile(input)
    },
    open: async () => {},
    saveFile: async () => undefined,
  },
}
mock.module("@/context/platform", () => ({ usePlatform: () => platform }))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key, locale: () => "en" }) }))
mock.module("@/context/sdk", () => ({ useSDK: () => () => ({ directory: state.directory }) }))
mock.module("@/context/settings", () => ({ useSettings: () => ({ general: { newLayoutDesigns: () => true } }) }))
mock.module("@/context/command", () => ({ useCommand: () => ({ keybindParts: () => [], keybind: () => "" }) }))
mock.module("@/context/layout", () => ({ useLayout: () => ({ terminal: { height: () => 240 } }) }))
mock.module("@/context/terminal", () => ({
  useTerminal: () => ({
    ready: () => false,
    all: () => [],
    active: () => undefined,
    focusRequested: () => false,
    cancelFocus: () => {},
  }),
}))
mock.module("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    workspaceKey: () => "811",
    view: () => ({ terminal: { opened: () => state.opened, close: () => setState("opened", false) } }),
  }),
}))
mock.module("@/pages/session/helpers", () => ({
  createSizing: () => ({ active: () => false, start: () => {} }),
  focusTerminalById: () => {},
}))
mock.module("@/components/terminal", () => ({ Terminal: () => null }))
mock.module("@/components/session/session-sortable-terminal-tab-v2", () => ({ SortableTerminalTabV2: () => null }))
const { TurnDeliverables } = await import("../../src/components/turn-deliverables")
const { TerminalPanelV2 } = await import("../../src/pages/session/terminal-panel-v2")
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  document.body.replaceChildren()
  reads.splice(0)
})

async function fixture() {
  const workspace = await mkdtemp(path.join(tmpdir(), "delivery811-"))
  cleanups.push(async () => {
    if (!path.resolve(workspace).startsWith(path.resolve(tmpdir()) + path.sep))
      throw new Error("unsafe fixture cleanup")
    await rm(workspace, { recursive: true, force: true })
  })
  const root = path.join(workspace, "project")
  await mkdir(root)
  await writeFile(path.join(root, "old.pdf"), "unchanged")
  await writeFile(path.join(root, "modified.csv"), "old")
  const started = Math.ceil((await stat(path.join(root, "modified.csv"))).birthtimeMs) + 1
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `await Bun.write(${JSON.stringify(path.join(root, "report.pdf"))},new Uint8Array([37,80,68,70,0,255]));await Bun.write(${JSON.stringify(path.join(root, "report.png"))},new Uint8Array([137,80,78,71,0,255]));await Bun.write(${JSON.stringify(path.join(root, "empty.txt"))},"")`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
  await writeFile(path.join(root, "modified.csv"), "new")
  await utimes(path.join(root, "modified.csv"), new Date(started + 1000), new Date(started + 1000))
  const finished = Math.max(Date.now(), started + 2000)
  const session: SessionV2Info = {
    id: "session811",
    projectID: "project",
    agent: "build",
    model: { id: "local", providerID: "fixture" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: started, updated: started },
    title: "811",
    location: { directory: root },
  }
  const content: Extract<SessionMessage, { type: "assistant" }>["content"] = [
    {
      id: "bash",
      type: "tool",
      name: "bash",
      time: { created: started, ran: started, completed: finished },
      state: {
        status: "completed",
        input: { command: "script generated binary files" },
        content: [],
        structured: {},
        outputPaths: [path.join(root, "command.txt")],
      },
    },
    {
      id: "final",
      type: "text",
      text: "[PDF](report.pdf) [PNG](report.png) `modified.csv` `empty.txt` `old.pdf` `missing.pdf` `command.txt` [escape](../escape.pdf)",
    },
  ]
  const rows = adaptSessionMessages(session, [
    { id: "user811", type: "user", text: "deliver files", time: { created: started } },
    {
      id: "answer811",
      type: "assistant",
      agent: "build",
      model: session.model!,
      time: { created: started + 1, completed: finished },
      content,
    },
  ])
  const items = turnDeliverables({
    messages: rows.map((r) => r.message),
    parts: Object.fromEntries(rows.map((r) => [r.message.id, r.parts])),
    messageID: "user811",
    directory: root,
  })
  return { root, started, items }
}

test("script binary outputs are verified from actual safe FS metadata; old/missing/log paths are excluded", async () => {
  const f = await fixture()
  const valid = await inspectTurnDeliverables(f.items, (target) => inspectArtifactFile({ target, directory: f.root }))
  expect(f.items.filter((item) => valid[item.target]).map((item) => item.target)).toEqual([
    "report.pdf",
    "report.png",
    "modified.csv",
    "empty.txt",
  ])
  expect(f.items.some((item) => item.target === "command.txt" || item.target.includes(".."))).toBe(false)
  expect([...(await readFile(path.join(f.root, "report.png")))]).toEqual([137, 80, 78, 71, 0, 255])
  await writeFile(path.join(f.root, "..", "outside.pdf"), "outside")
  await symlink(path.join(f.root, "..", "outside.pdf"), path.join(f.root, "linked.pdf"))
  expect(
    await inspectTurnDeliverables(
      [{ target: "linked.pdf", kind: "file", source: "reply", after: f.started }],
      (target) => inspectArtifactFile({ target, directory: f.root }),
    ),
  ).toEqual({ "linked.pdf": false })
})

test("actual Solid cards show binary/empty/modified outputs and hide unverified declarations", async () => {
  const f = await fixture()
  setState("directory", f.root)
  const host = document.createElement("main")
  document.body.append(host)
  cleanups.push(
    render(
      () => <TurnDeliverables items={f.items} directory={state.directory} onPreview={() => {}} onOpenFile={() => {}} />,
      host,
    ),
  )
  for (let n = 0; n < 60 && host.querySelectorAll("li").length !== 4; n++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect([...host.querySelectorAll("li")].map((li) => li.querySelector("span")?.textContent)).toEqual([
    "report.pdf",
    "report.png",
    "modified.csv",
    "empty.txt",
  ])
  expect([...host.querySelectorAll("button")].every((button) => !button.disabled)).toBe(true)
  expect(reads.sort()).toEqual(["empty.txt", "missing.pdf", "modified.csv", "old.pdf", "report.pdf", "report.png"])
})

test("a new turn cannot reuse the prior turn's verification for the same path", async () => {
  const f = await fixture()
  const [items, setItems] = createSignal(f.items)
  setState("directory", f.root)
  const host = document.createElement("main")
  document.body.append(host)
  cleanups.push(
    render(
      () => <TurnDeliverables items={items()} directory={state.directory} onPreview={() => {}} onOpenFile={() => {}} />,
      host,
    ),
  )
  for (let n = 0; n < 60 && host.querySelectorAll("li").length !== 4; n++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect(host.querySelectorAll("li")).toHaveLength(4)
  setItems(f.items.map((item) => ({ ...item, after: Date.now() + 10_000 })))
  expect(host.querySelectorAll("li")).toHaveLength(0)
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(host.querySelector("section")).toBeNull()
})

test("unavailable metadata does not promote a reply claim, while trusted carriers remain available", async () => {
  expect(
    await inspectTurnDeliverables(
      [
        { target: "trusted.pdf", kind: "file", source: "tool" },
        { target: "claim.pdf", kind: "file", source: "reply", after: 100 },
      ],
      async () => undefined,
    ),
  ).toEqual({ "trusted.pdf": true, "claim.pdf": false })
})

test("900px narrow layout overrides the viewport breakpoint, then grows without recreating the panel", () => {
  window.resizeTo(900, 700)
  setState({ desktop: false, opened: true })
  const host = document.createElement("main")
  document.body.append(host)
  cleanups.push(render(() => <TerminalPanelV2 desktop={state.desktop} />, host))
  const panel = host.querySelector<HTMLElement>("#terminal-panel")!
  expect(panel.classList.contains("w-full")).toBe(true)
  expect(panel.style.height).toBe("240px")
  expect(panel.firstElementChild?.classList.contains("hidden")).toBe(false)
  window.resizeTo(1280, 700)
  setState("desktop", true)
  expect(host.querySelector("#terminal-panel")).toBe(panel)
  expect(panel.classList.contains("flex-1")).toBe(true)
  expect(panel.style.height).toBe("100%")
  expect(panel.firstElementChild?.classList.contains("hidden")).toBe(true)
})
