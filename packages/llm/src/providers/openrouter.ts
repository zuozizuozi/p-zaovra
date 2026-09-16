import { Effect, Schema } from "effect"
import { Route, type RouteDefaultsInput } from "../route/client"
import { Endpoint } from "../route/endpoint"
import { Protocol } from "../route/protocol"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import { LLMEvent, ProviderID, type ModelID, type ProviderOptions } from "../schema"
import { profiles } from "./openai-compatible-profile"
import { Lifecycle } from "../protocols/utils/lifecycle"
import { OpenAIChat } from "../protocols/openai-chat"
import { isRecord, optionalNull } from "../protocols/shared"

export const profile = profiles.openrouter
export const id = ProviderID.make(profile.provider)
const ADAPTER = "openrouter"

export interface OpenRouterOptions {
  readonly [key: string]: unknown
  readonly usage?: boolean | Record<string, unknown>
  readonly reasoning?: Record<string, unknown>
  readonly promptCacheKey?: string
}

export type OpenRouterProviderOptionsInput = ProviderOptions & {
  readonly openrouter?: OpenRouterOptions
}

export type ModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: OpenRouterProviderOptionsInput
  }

const OpenRouterAssistant = Schema.Struct({
  ...OpenAIChat.OpenAIChatMessage.cases.assistant.fields,
  reasoning: Schema.optional(Schema.String),
  reasoning_details: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
})
const OpenRouterBody = Schema.StructWithRest(
  Schema.Struct({
    ...OpenAIChat.bodyFields,
    messages: Schema.Array(Schema.Union([OpenRouterAssistant, OpenAIChat.OpenAIChatMessage])),
  }),
  [Schema.Record(Schema.String, Schema.Any)],
)
export type OpenRouterBody = Schema.Schema.Type<typeof OpenRouterBody>

const OpenRouterEvent = Schema.Struct({
  ...OpenAIChat.OpenAIChatEvent.fields,
  choices: Schema.Array(
    Schema.Struct({
      finish_reason: optionalNull(Schema.String),
      delta: optionalNull(
        Schema.Struct({
          ...OpenAIChat.OpenAIChatDelta.fields,
          reasoning: optionalNull(Schema.String),
          reasoning_details: optionalNull(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
        }),
      ),
    }),
  ),
})

export const protocol = Protocol.make({
  id: "openrouter-chat",
  body: {
    schema: OpenRouterBody,
    from: (request) =>
      OpenAIChat.protocol.body.from(request).pipe(
        Effect.map((body) => {
          const assistants = request.messages.filter((message) => message.role === "assistant")
          return {
            ...body,
            messages: body.messages.map((message) => {
              if (message.role !== "assistant") return message
              const source = assistants.shift()
              const details =
                source?.content.flatMap((part) => {
                  if (part.type !== "reasoning") return []
                  const native = part.providerMetadata?.openrouter
                  return isRecord(native) && Array.isArray(native.reasoning_details)
                    ? native.reasoning_details.filter(isRecord)
                    : []
                }) ?? []
              const { reasoning_content, ...rest } = message
              return {
                ...rest,
                ...(details.length > 0
                  ? { reasoning_details: details }
                  : reasoning_content
                    ? { reasoning: reasoning_content }
                    : {}),
              }
            }),
            ...bodyOptions(request.providerOptions?.openrouter),
          }
        }),
      ),
  },
  stream: {
    event: Protocol.jsonEvent(OpenRouterEvent),
    initial: (request) => ({
      base: OpenAIChat.protocol.stream.initial(request),
      reasoningStarted: false,
      details: [] as ReadonlyArray<Record<string, unknown>>,
    }),
    step: (state, event) =>
      Effect.gen(function* () {
        const delta = event.choices[0]?.delta
        const details = [...state.details]
        // Reconstruct consecutive unsigned text deltas into their original block.
        // Signed/encrypted blocks and changes in identity stay byte-for-byte intact.
        for (const detail of delta?.reasoning_details ?? []) {
          const previous = details.at(-1)
          if (
            previous &&
            detail.type === "reasoning.text" &&
            previous.type === detail.type &&
            typeof detail.text === "string" &&
            typeof previous.text === "string" &&
            detail.index !== undefined &&
            detail.index === previous.index &&
            !detail.signature &&
            !previous.signature &&
            [...Object.keys(previous), ...Object.keys(detail)].every(
              (key) => key === "text" || previous[key] === detail[key],
            )
          ) {
            details[details.length - 1] = { ...previous, text: previous.text + detail.text }
            continue
          }
          details.push(detail)
        }
        // OpenRouter often sends both the plain text and its detailed representation.
        const text =
          delta?.reasoning ??
          delta?.reasoning_content ??
          delta?.reasoning_details
            ?.map((detail) =>
              detail.type === "reasoning.text" && typeof detail.text === "string"
                ? detail.text
                : detail.type === "reasoning.summary" && typeof detail.summary === "string"
                  ? detail.summary
                  : "",
            )
            .join("") ??
          ""
        const events: LLMEvent[] = []
        const reasoningStarted = state.reasoningStarted || text.length > 0 || details.length > 0
        const lifecycle = reasoningStarted ? Lifecycle.stepStart(state.base.lifecycle, events) : state.base.lifecycle
        if (reasoningStarted && !state.reasoningStarted)
          events.push(LLMEvent.reasoningStart({ id: "openrouter-reasoning" }))
        if (text) events.push(LLMEvent.reasoningDelta({ id: "openrouter-reasoning", text }))
        const [base, parsed] = yield* OpenAIChat.protocol.stream.step(
          { ...state.base, lifecycle },
          {
            ...event,
            choices: event.choices.map((choice) => ({
              ...choice,
              delta: choice.delta ? { ...choice.delta, reasoning_content: undefined } : choice.delta,
            })),
          },
        )
        return [{ base, reasoningStarted, details }, [...events, ...parsed]] as const
      }),
    onHalt: (state) => [
      ...(state.reasoningStarted
        ? [
            LLMEvent.reasoningEnd({
              id: "openrouter-reasoning",
              providerMetadata:
                state.details.length > 0 ? { openrouter: { reasoning_details: state.details } } : undefined,
            }),
          ]
        : []),
      ...(OpenAIChat.protocol.stream.onHalt?.(state.base) ?? []),
    ],
  },
})

const bodyOptions = (input: unknown) => {
  const openrouter = isRecord(input) ? input : {}
  return {
    ...(openrouter.usage === true
      ? { usage: { include: true } }
      : isRecord(openrouter.usage)
        ? { usage: openrouter.usage }
        : {}),
    ...(isRecord(openrouter.reasoning) ? { reasoning: openrouter.reasoning } : {}),
    ...(typeof openrouter.promptCacheKey === "string" ? { prompt_cache_key: openrouter.promptCacheKey } : {}),
  }
}

export const route = Route.make({
  id: ADAPTER,
  provider: profile.provider,
  protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL: profile.baseURL }),
  framing: OpenAIChat.framing,
})

export const routes = [route]

const configuredRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return route.with({
    ...rest,
    endpoint: { baseURL: baseURL ?? profile.baseURL },
    auth: AuthOptions.bearer(input, "OPENROUTER_API_KEY"),
  })
}

export const configure = (input: ModelOptions = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) => route.model({ id: modelID }),
    configure,
  }
}

export const provider = configure()
export const model = provider.model

export * as OpenRouter from "./openrouter"
