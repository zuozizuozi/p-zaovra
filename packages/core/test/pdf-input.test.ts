import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Model } from "@zaovra-ai/llm"
import { AnthropicMessages } from "@zaovra-ai/llm/protocols/anthropic-messages"
import { OpenAIChat } from "@zaovra-ai/llm/protocols/openai-chat"
import { Pdf } from "../src/pdf"
import { prepareLLMMessages } from "../src/session/runner/prepare-llm-message"
import { SessionMessage } from "../src/session/message"
import { DateTime } from "effect"
import { it } from "./lib/effect"

const bytes = () => Effect.promise(() => Bun.file(new URL("./fixtures/pdf-text.pdf", import.meta.url)).bytes())
const textModel = Object.assign(Model.make({ id: "text-only", provider: "offline", route: OpenAIChat.route }), {
  inputModalities: ["text"],
})

describe("PDF input", () => {
  it.effect("extracts actual PDF text without native rendering", () =>
    Effect.gen(function* () {
      const result = yield* Pdf.text(yield* bytes())
      expect(result.pages).toBe(1)
      expect(result.text).toContain("Zaovra PDF text fixture")
      expect(result.text).toContain("Second paragraph survives extraction.")
      expect(result.truncated).toBe(false)
    }),
  )

  it.effect("sends extracted user text to a text-only route and restores the original PDF on a supported route", () =>
    Effect.gen(function* () {
      const uri = "data:application/pdf;base64," + Buffer.from(yield* bytes()).toString("base64")
      const history: SessionMessage.Message[] = [
        {
          type: "user",
          id: SessionMessage.ID.make("msg_pdf"),
          text: "Read this PDF",
          time: { created: DateTime.makeUnsafe(0) },
          files: [{ mime: "application/pdf", uri, name: "notes.pdf" }],
        },
      ]
      const original = JSON.stringify(history)
      const projected = yield* prepareLLMMessages(history, textModel)
      expect(JSON.stringify(projected)).toContain("Zaovra PDF text fixture")
      expect(JSON.stringify(projected)).toContain("images and layout were not sent")
      expect(JSON.stringify(projected)).not.toContain("base64")
      const native = yield* prepareLLMMessages(
        history,
        Object.assign(Model.make({ id: "claude-haiku-5-5", provider: "offline", route: AnthropicMessages.route }), {
          inputModalities: ["text", "pdf"],
        }),
      )
      expect(native[0]?.content.some((part) => part.type === "media" && part.data === uri)).toBe(true)
      expect(JSON.stringify(history)).toBe(original)
    }),
  )

  it.effect("reports malformed PDFs without claiming their contents were viewed", () =>
    Effect.gen(function* () {
      const history: SessionMessage.Message[] = [
        {
          type: "user",
          id: SessionMessage.ID.make("msg_bad_pdf"),
          text: "Read this",
          time: { created: DateTime.makeUnsafe(0) },
          files: [{ mime: "application/pdf", uri: "data:application/pdf;base64,YmFk", name: "bad.pdf" }],
        },
      ]
      const messages = yield* prepareLLMMessages(history, textModel)
      expect(JSON.stringify(messages)).toContain("text extraction failed")
      expect(JSON.stringify(messages)).toContain("have not been viewed")
    }),
  )

  it.effect("does not fetch remote PDF references for unsupported routes", () =>
    Effect.gen(function* () {
      const history: SessionMessage.Message[] = [
        {
          type: "user",
          id: SessionMessage.ID.make("msg_remote_pdf"),
          text: "Read this",
          time: { created: DateTime.makeUnsafe(0) },
          files: [{ mime: "application/pdf", uri: "https://no-network.invalid/doc.pdf", name: "remote.pdf" }],
        },
      ]
      const messages = yield* prepareLLMMessages(history, textModel)
      expect(JSON.stringify(messages)).toContain("no inline bytes")
      expect(JSON.stringify(messages)).toContain("have not been viewed")
    }),
  )
})

it.effect("700 a PDF catalog flag cannot bypass a transport without native document blocks", () =>
  Effect.gen(function* () {
    const uri = "data:application/pdf;base64," + Buffer.from(yield* bytes()).toString("base64")
    const history: SessionMessage.Message[] = [
      {
        type: "user",
        id: SessionMessage.ID.make("msg_route_pdf"),
        text: "Read",
        time: { created: DateTime.makeUnsafe(0) },
        files: [{ mime: "application/pdf", uri, name: "route.pdf" }],
      },
    ]
    const projected = yield* prepareLLMMessages(
      history,
      Object.assign(Model.make(Model.input(textModel)), { inputModalities: ["text", "pdf"] }),
    )
    expect(JSON.stringify(projected)).toContain("Zaovra PDF text fixture")
    expect(projected[0]?.content.some((part) => part.type === "media")).toBe(false)
  }),
)
