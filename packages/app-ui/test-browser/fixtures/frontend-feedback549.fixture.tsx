import { afterEach, expect, mock, test } from "bun:test"
import { createRoot, For } from "solid-js"
import { render } from "solid-js/web"
import type { Message, Part, SessionMessage, SessionV2Info } from "@zaovra-ai/sdk/v2/client"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { Feedback } from "@zaovra-ai/schema/feedback"
import { adaptSessionMessages } from "../../src/context/v2-session-adapter"
import { createTimelineProjection } from "../../src/pages/session/timeline/projection"
import { processMessages } from "../../src/pages/session/timeline/process-messages"
import { ProcessMessages } from "../../src/pages/session/timeline/process-messages-view"
import { openFeedback } from "../../src/feedback"

const session: SessionV2Info = {
  id: "ses_549",
  projectID: "global",
  agent: "build",
  model: { id: "offline", providerID: "fixture" },
  location: { directory: "/fixture" },
  title: "5 background commands",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 100 },
}
const jobs: SessionMessage[] = [
  { type: "user", id: "msg_user", text: "Run five checks", time: { created: 1 } },
  {
    type: "assistant",
    id: "msg_assistant",
    agent: "build",
    model: session.model!,
    time: { created: 2, completed: 3 },
    content: Array.from({ length: 5 }, (_, i) => ({
      type: "tool" as const,
      id: "call_" + i,
      name: "bash",
      time: { created: 2, completed: 3 },
      state: {
        status: "completed" as const,
        input: { command: "check " + i, run_in_background: true },
        structured: { job_id: "msg_job_" + i },
        content: [{ type: "text" as const, text: "Background command started" }],
      },
    })),
  },
  ...Array.from(
    { length: 5 },
    (_, i): SessionMessage => ({
      type: "shell",
      origin: "tool",
      id: "msg_job_" + i,
      callID: "call_" + i,
      command: "check " + i,
      output: "Done " + i,
      time: { created: 4 + i, completed: 10 + i },
    }),
  ),
  ...Array.from(
    { length: 5 },
    (_, i): SessionMessage => ({
      type: "synthetic",
      sessionID: session.id,
      id: "msg_done_" + i,
      text: "Command completed " + i,
      completion: { type: "bash-completion", sourceMessageID: "msg_assistant", jobID: "msg_job_" + i },
      time: { created: 20 + i },
    }),
  ),
]

test("five durable background jobs update five original cards, no synthetic user rows, and generic process notes expand", () => {
  createRoot((dispose) => {
    const adapted = adaptSessionMessages(session, jobs)
    const parts: Record<string, Part[]> = Object.fromEntries(adapted.map((item) => [item.message.id, item.parts]))
    const messages = adapted.map((item) => item.message)
    const projection = createTimelineProjection({
      messages: () => messages,
      userMessages: () => messages.filter((m) => m.role === "user"),
      parts: (id) => parts[id] ?? [],
      status: () => ({ type: "idle" }),
      showReasoningSummaries: () => true,
      inlineComments: () => true,
    })
    expect(
      projection
        .rows()
        .filter((row) => row._tag === "UserMessage")
        .map((row) => row.userMessageID),
    ).toEqual(["msg_user"])
    expect(
      projection
        .rows()
        .flatMap((row) =>
          row._tag === "AssistantPart" ? (row.group.type === "part" ? [row.group.ref] : row.group.refs) : [],
        ),
    ).toHaveLength(5)
    expect(projection.rows().filter((row) => row._tag === "ProcessMessages")).toHaveLength(0)
    for (const part of parts.msg_assistant) {
      expect(part).toMatchObject({ type: "tool", state: { metadata: { zaovraBackgroundState: "completed" } } })
      if (part.type === "tool" && part.state.status === "completed")
        expect(part.state.metadata.zaovraBackgroundOutput).toContain("Done")
    }
    const notes = adapted
      .filter((item) => item.message.id.startsWith("msg_job") || item.message.id.startsWith("msg_done"))
      .flatMap((item) => item.parts)
    const entries = processMessages(notes, new Set())
    expect(entries).toHaveLength(5)
    const host = document.createElement("main")
    const unmount = render(() => <ProcessMessages entries={entries} />, host)
    expect(host.querySelectorAll("[data-component=process-message]")).toHaveLength(5)
    expect(host.textContent).not.toContain("系统跟进")
    const outer = host.querySelector("details")!
    expect(outer.open).toBe(false)
    outer.querySelector("summary")!.click()
    expect(outer.open).toBe(true)
    unmount()
    dispose()
  })
})

test("completion without a loaded shell still updates the matching original card", () => {
  const result = adaptSessionMessages(
    session,
    jobs.filter((item) => item.type !== "shell"),
  )
  expect(result.find((item) => item.message.id === "msg_assistant")?.parts[0]).toMatchObject({
    state: { metadata: { zaovraBackgroundState: "completed", zaovraBackgroundOutput: "Command completed 0" } },
  })
})

test("orphan and manual process notes remain expandable without borrowing a later user turn", () => {
  createRoot((dispose) => {
    const adapted = adaptSessionMessages(session, [
      jobs.at(-1)!,
      { type: "user", id: "msg_later", text: "New request", time: { created: 50 } },
    ])
    const messages = adapted.map((item) => item.message)
    const parts: Record<string, Part[]> = Object.fromEntries(adapted.map((item) => [item.message.id, item.parts]))
    const projection = createTimelineProjection({
      messages: () => messages,
      userMessages: () => messages.filter((m) => m.role === "user"),
      parts: (id) => parts[id] ?? [],
      status: () => ({ type: "idle" }),
      showReasoningSummaries: () => true,
      inlineComments: () => true,
    })
    expect(
      projection
        .rows()
        .filter((row) => row._tag === "ProcessMessages")
        .map((row) => row.userMessageID),
    ).toEqual(["msg_done_4"])
    expect(projection.displayTurns().get("msg_done_4")).toBe("msg_done_4")
    dispose()
  })
})

const scene: { messages: Message[]; parts: Record<string, Part[]> } = { messages: [], parts: {} }
let archive: Feedback.Snapshot | undefined
const language = { locale: () => "zh", t: (key: string) => key }
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@solidjs/router", () => ({ useParams: () => ({ id: session.id }) }))
mock.module("@/context/server-sync", () => ({
  useServerSync: () => () => ({
    session: {
      data: { info: { [session.id]: session }, message: { [session.id]: scene.messages }, part: scene.parts },
    },
  }),
}))
mock.module("@/context/server-sdk", () => ({
  useServerSDK: () => () => ({ client: { v2: { session: { list: async () => ({ data: { data: [] } }) } } } }),
}))
mock.module("@/components/settings-dialog", () => ({ useSettingsDialog: () => () => {} }))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    platform: "desktop",
    os: "windows",
    version: "1.18.3",
    saveFeedback: async (snapshot: Feedback.Snapshot) => {
      archive = snapshot
      return true
    },
  }),
}))
const { FeedbackScene } = await import("../../src/components/feedback-scene")
const { FeedbackHost } = await import("../../src/components/feedback-host")
const disposals: (() => void)[] = []
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  archive = undefined
})
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name)!
test("menu feedback for the very first 400 saves status/request id and message events without bodies or credentials", async () => {
  const now = Date.now()
  const adapted = adaptSessionMessages(session, [
    { type: "user", id: "msg_user", text: "PRIVATE_USER_BODY", time: { created: now - 2 } },
    {
      type: "assistant",
      id: "msg_error",
      agent: "build",
      model: session.model!,
      time: { created: now - 1, completed: now },
      content: [],
      error: {
        type: "unknown",
        message: "HTTP 400 invalid tool request (request_id: req_fixture_549) api_key=sk-SYNTHETICSECRET549",
        metadata: { statusCode: "400", request_id: "req_fixture_549", diagnostics: "PRIVATE_PROVIDER_BODY" },
      },
    },
  ])
  scene.messages = adapted.map((item) => item.message)
  scene.parts = Object.fromEntries(adapted.map((item) => [item.message.id, item.parts]))
  const host = document.createElement("main")
  document.body.append(host)
  disposals.push(
    render(
      () => (
        <I18nProvider value={language}>
          <FeedbackScene />
          <FeedbackHost />
        </I18nProvider>
      ),
      host,
    ),
  )
  openFeedback({ description: "First message failed" })
  await new Promise((resolve) => setTimeout(resolve, 25))
  button("继续反馈").click()
  await new Promise((resolve) => setTimeout(resolve, 25))
  button("保存诊断包 ZIP").click()
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(archive).toBeDefined()
  expect(archive!.files.map((file) => file.name)).toEqual(["report.json", "model.txt"])
  const text = archive!.text
  const report = JSON.parse(text)
  expect(report.errors).toHaveLength(1)
  expect(report.errors[0]).toMatchObject({ status: 400, requestID: "req_fixture_549" })
  expect(report.errors[0].message).toContain("HTTP 400")
  expect(report.events.filter((event: { kind: string }) => event.kind === "message")).toHaveLength(2)
  for (const secret of ["PRIVATE_USER_BODY", "PRIVATE_PROVIDER_BODY", "SYNTHETICSECRET549"])
    expect(text).not.toContain(secret)
})
