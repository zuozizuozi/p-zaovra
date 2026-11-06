import { Message, type ContentPart, type ToolContent } from "@zaovra-ai/llm"
import { Effect } from "effect"
import { Pdf } from "../../pdf"
import { SessionMessage } from "../message"
import { toLLMMessages } from "./to-llm-message"
import type { ResolvedModel } from "./model"

/** Keep the original PDF in history; text-only routes receive extracted text in ordinary user/tool content. */
export const prepareLLMMessages = Effect.fn("SessionRunner.prepareLLMMessages")(function* (
  history: readonly SessionMessage.Message[],
  model: ResolvedModel,
  originalRequests?: string,
) {
  const messages = toLLMMessages(history, model, originalRequests, true)
  if (
    model.inputModalities?.includes("pdf") &&
    ["anthropic-messages", "bedrock-converse"].includes(model.route.protocol)
  )
    return messages
  return yield* Effect.forEach(messages, (message) =>
    Effect.gen(function* () {
      const content = yield* Effect.forEach(message.content, (part): Effect.Effect<ContentPart> => {
        if (part.type === "media" && part.mediaType === "application/pdf") return pdfText(part.data, part.filename)
        if (part.type !== "tool-result" || part.result.type !== "content") return Effect.succeed(part)
        const content: readonly ToolContent[] = part.result.value
        return Effect.forEach(content, (item) =>
          item.type === "file" && item.mime === "application/pdf" ? pdfText(item.uri, item.name) : Effect.succeed(item),
        ).pipe(Effect.map((value) => ({ ...part, result: { type: "content" as const, value } })))
      })
      return Message.make({ ...message, content })
    }),
  )
})

function pdfText(data: string | Uint8Array, name?: string) {
  const label = name ?? "PDF attachment"
  const encoded = typeof data === "string" ? data.match(/^data:application\/pdf;base64,(.*)$/s)?.[1] : undefined
  if (typeof data === "string" && encoded === undefined)
    return Effect.succeed({
      type: "text" as const,
      text: `[PDF ${JSON.stringify(label)} cannot be read by this model: no inline bytes are available for text extraction. Its contents have not been viewed.]`,
    })
  if ((encoded?.length ?? data.length) > (Pdf.MAX_BYTES * 4) / 3 + 4)
    return Effect.succeed({
      type: "text" as const,
      text: `[PDF ${JSON.stringify(label)} exceeds the text extraction limit. Its contents have not been viewed.]`,
    })
  return Pdf.text(typeof data === "string" ? Buffer.from(encoded!, "base64") : data).pipe(
    Effect.map((result) => ({
      type: "text" as const,
      text: `[PDF ${JSON.stringify(label)}: extracted text only; images and layout were not sent to this model.]\n${result.text}`,
    })),
    Effect.catchTag("Pdf.DecodeError", (error) =>
      Effect.succeed({
        type: "text" as const,
        text: `[PDF ${JSON.stringify(label)} text extraction failed: ${error.message}. Its contents have not been viewed.]`,
      }),
    ),
  )
}
