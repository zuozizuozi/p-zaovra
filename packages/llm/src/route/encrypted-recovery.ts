import { Effect, Stream } from "effect"
import { HttpOptions, LLMRequest, Message, type LLMError, type LLMEvent } from "../schema"
import { providerEventError } from "../provider-error"
import { RequestExecutor } from "./executor"

/** One compatibility retry before output; never change persisted conversation history. */
export const recoverEncryptedContent =
  (request: LLMRequest, retry: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>) =>
  (stream: Stream.Stream<LLMEvent, LLMError>) => {
    const protocol = request.model.route.protocol
    if (request.model.route.transport.id !== "http-json" || !["openai-responses", "openai-chat"].includes(protocol))
      return stream
    return Stream.unwrap(
      Effect.sync(() => {
        let committed = false
        let failedEvent: Extract<LLMEvent, { type: "provider-error" }> | undefined
        const pending: LLMEvent[] = []
        return stream.pipe(
          Stream.mapEffect((event) => {
            if (!committed && event.type === "provider-error" && event.code === "invalid_encrypted_content") {
              failedEvent = event
              return Effect.fail(providerEventError(event))
            }
            return Effect.succeed(event)
          }),
          Stream.map((event) => {
            // Buffer only starts that cannot carry text, tools, usage or opaque reasoning.
            if (
              !committed &&
              pending.length < 32 &&
              (event.type === "step-start" ||
                ((event.type === "text-start" || event.type === "reasoning-start") && !event.providerMetadata))
            ) {
              pending.push(event)
              return []
            }
            committed = true
            return [...pending.splice(0), event]
          }),
          Stream.flattenIterable,
          Stream.concat(Stream.unwrap(Effect.sync(() => Stream.fromIterable(pending.splice(0))))),
          Stream.catchTag("LLM.Error", (error) => {
            const next =
              !committed &&
              error.reason._tag === "InvalidRequest" &&
              error.reason.providerMetadata?.compatibility?.code === "invalid_encrypted_content"
                ? withoutEncryptedContent(request)
                : undefined
            if (!next)
              return Stream.concat(
                Stream.fromIterable(pending.splice(0)),
                failedEvent ? Stream.make(failedEvent) : Stream.fail(error),
              )
            return Stream.unwrap(
              Effect.logInfo("provider.request.encrypted_reasoning_recovery").pipe(
                Effect.as(retry(next).pipe(Stream.provideService(RequestExecutor.AutomaticRetries, false))),
              ),
            )
          }),
        )
      }),
    )
  }

function withoutEncryptedContent(request: LLMRequest) {
  const responses = request.model.route.protocol === "openai-responses"
  const include = request.providerOptions?.openai?.include
  const overlay = request.http?.body?.include
  const messages = request.messages.flatMap((message) => {
    if (message.role !== "assistant") return [message]
    const content = responses
      ? message.content.filter((part) => part.type !== "reasoning")
      : message.content.map((part) =>
          part.type !== "reasoning" || !part.providerMetadata?.openaiCompatible
            ? part
            : {
                ...part,
                providerMetadata: {
                  ...part.providerMetadata,
                  openaiCompatible: omitCipher(part.providerMetadata.openaiCompatible),
                },
              },
        )
    if (message.content.length > 0 && content.length === 0) return []
    return [
      new Message({
        ...message,
        content,
        native: message.native?.openaiCompatible
          ? {
              ...message.native,
              openaiCompatible: omitCipher(message.native.openaiCompatible),
            }
          : message.native,
      }),
    ]
  })
  const changed =
    (Array.isArray(include) && include.includes("reasoning.encrypted_content")) ||
    (Array.isArray(overlay) && overlay.includes("reasoning.encrypted_content")) ||
    request.messages.some(
      (message) =>
        message.role === "assistant" &&
        (hasCipher(message.native?.openaiCompatible) ||
          message.content.some(
            (part) => part.type === "reasoning" && (responses || hasCipher(part.providerMetadata?.openaiCompatible)),
          )),
    )
  if (!changed) return
  return LLMRequest.update(request, {
    messages,
    providerOptions: {
      ...request.providerOptions,
      openai: {
        ...request.providerOptions?.openai,
        ...(Array.isArray(include)
          ? { include: include.filter((item) => item !== "reasoning.encrypted_content") }
          : {}),
      },
    },
    http: request.http
      ? new HttpOptions({
          ...request.http,
          body: request.http.body
            ? {
                ...request.http.body,
                ...(Array.isArray(overlay)
                  ? { include: overlay.filter((item) => item !== "reasoning.encrypted_content") }
                  : {}),
              }
            : undefined,
        })
      : undefined,
  })
}

function hasCipher(value: unknown) {
  return value !== null && typeof value === "object" && "encrypted_content" in value
}

function omitCipher<T>(value: T) {
  if (!hasCipher(value)) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "encrypted_content"),
  )
}
