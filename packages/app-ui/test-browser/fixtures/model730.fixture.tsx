import { expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { Effect, Schema, Stream } from "effect"
import { OpenAIChat } from "@zaovra-ai/llm/protocols/openai-chat"
import { sseEvents } from "../../../llm/test/lib/sse"
import { createServerSession } from "../../src/context/server-session"
import { adaptSession, adaptSessionMessages } from "../../src/context/v2-session-adapter"
import { DataProvider } from "@zaovra-ai/session-ui/context"
import type { ZaovraClient, SessionV2Info } from "@zaovra-ai/sdk/v2/client"

// Markdown parsing is outside the footer's provenance path.
mock.module("../../../session-ui/src/components/markdown", () => ({
  Markdown: (props: { text: string }) => <div>{props.text}</div>,
}))
const { PART_MAPPING } = await import("@zaovra-ai/session-ui/message-part")
const Text = PART_MAPPING.text!

test.each([false, true])(
  "730 actual %s action-style footer updates from production framing before history refresh and survives reload",
  async (v2) => {
    // Full HTTP protocol propagation is covered by the new730 LLM route tests.
    const frames = await Effect.runPromise(
      OpenAIChat.framing
        .frame(
          Stream.make(
            new TextEncoder().encode(
              sseEvents(
                { model: "returned-wire730", choices: [{ delta: { role: "assistant" } }] },
                { choices: [{ delta: { content: "Result" }, finish_reason: "stop" }] },
              ),
            ),
          ),
        )
        .pipe(Stream.runCollect),
    )
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(OpenAIChat.OpenAIChatEvent))
    const actual = frames.map((frame) => decode(frame)).find((event) => typeof event.model === "string")?.model
    expect(actual).toBe("returned-wire730")
    const session: SessionV2Info = {
      id: "ses_dom730",
      projectID: "project",
      agent: "build",
      model: { id: "selected-alias", providerID: "provider" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
      title: "730 DOM",
      location: { directory: "F:/synthetic730" },
    }
    const gate = Promise.withResolvers<void>()
    const client = {
      v2: {
        session: {
          active: async () => ({ data: { data: {} } }),
          wait: async () => {},
          get: async () => ({ data: { data: session } }),
          messages: async () => {
            await gate.promise
            return { data: { data: [], cursor: {} } }
          },
          pendingInputs: async () => ({ data: { data: [] } }),
        },
        question: { request: { list: async () => ({ data: { data: [] } }) } },
        permission: { request: { list: async () => ({ data: { data: [] } }) } },
      },
    } as unknown as ZaovraClient
    const store = createServerSession(client)
    store.set("info", session.id, adaptSession(session))
    const row = adaptSessionMessages(session, [
      { id: "a-user", type: "user", text: "Test", time: { created: 1 } },
      {
        id: "b-answer",
        type: "assistant",
        agent: "build",
        model: session.model!,
        time: { created: 2, completed: 3 },
        content: [{ id: "text-0", type: "text", text: "Result" }],
      },
    ])
    store.set(
      "message",
      session.id,
      row.map((item) => item.message),
    )
    store.set("part", "b-answer", row[1].parts)
    const root = document.createElement("div")
    document.body.append(root)
    const dispose = render(
      () => (
        <DataProvider
          directory={session.location.directory}
          data={{
            session: [],
            session_status: {},
            session_diff: {},
            message: store.data.message,
            part: store.data.part,
          }}
        >
          <Text part={store.data.part["b-answer"][0]} message={store.data.message[session.id][1]} useV2Actions={v2} />
        </DataProvider>
      ),
      root,
    )
    try {
      expect(root.querySelector('[data-slot="text-part-meta"]')?.textContent).toContain("Actual model not reported")
      store.apply({
        type: "session.next.step.ended",
        properties: {
          sessionID: session.id,
          assistantMessageID: "b-answer",
          timestamp: 4,
          finish: "stop",
          responseModel: actual,
        },
      })
      expect(root.querySelector('[data-slot="text-part-meta"]')?.textContent).toContain("returned-wire730")
      expect(root.querySelector('[data-slot="text-part-meta"]')?.textContent).not.toContain("Actual model not reported")
      // The durable adapter already carries this field; a fresh projection must agree.
      const reloaded = adaptSessionMessages(session, [
        { id: "a-user", type: "user", text: "Test", time: { created: 1 } },
        {
          id: "b-answer",
          type: "assistant",
          agent: "build",
          model: session.model!,
          metadata: { responseModel: actual },
          time: { created: 2, completed: 4 },
          content: [{ id: "text-0", type: "text", text: "Result" }],
        },
      ])
      store.set("part", "b-answer", reloaded[1].parts)
      expect(root.querySelector('[data-slot="text-part-meta"]')?.textContent).toContain("returned-wire730")
    } finally {
      dispose()
      root.remove()
      gate.resolve()
    }
  },
)
