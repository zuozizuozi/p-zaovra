import { Effect, Stream } from "effect"
import { Headers, HttpClientRequest } from "effect/unstable/http"
import { Auth } from "../auth"
import { render as renderEndpoint } from "../endpoint"
import { Framing, type Framing as FramingDef } from "../framing"
import type { Transport, TransportPrepareInput } from "./index"
import * as ProviderShared from "../../protocols/shared"
import { LLMError, TransportReason, mergeJsonRecords, type LLMRequest } from "../../schema"

export type JsonRequestInput<Body> = TransportPrepareInput<Body>

export interface JsonRequestParts<Body = unknown> {
  readonly url: string
  readonly jsonBody: Body | Record<string, unknown>
  readonly bodyText: string
  readonly headers: Headers.Headers
}

export interface HttpPrepared<Frame> {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly framing: FramingDef<Frame>
}

const applyQuery = (url: string, query: Record<string, string> | undefined) => {
  if (!query) return url
  const next = new URL(url)
  Object.entries(query).forEach(([key, value]) => next.searchParams.set(key, value))
  return next.toString()
}

const PROTOCOL_BODY_OVERLAY_DENYLIST = new Set([
  "content",
  "contents",
  "frequencyPenalty",
  "frequency_penalty",
  "generationConfig",
  "inferenceConfig",
  "input",
  "maxTokens",
  "max_tokens",
  "messages",
  "model",
  "presencePenalty",
  "presence_penalty",
  "responseFormat",
  "response_format",
  "seed",
  "stop",
  "stopSequences",
  "stop_sequences",
  "stream",
  "streamOptions",
  "stream_options",
  "system",
  "systemInstruction",
  "system_instruction",
  "temperature",
  "thinking",
  "toolChoice",
  "toolConfig",
  "tool_choice",
  "tool_config",
  "tools",
  "topK",
  "topP",
  "top_k",
  "top_p",
])

const forbiddenBodyOverlayKeys = (body: Record<string, unknown>) =>
  Object.keys(body).filter((key) => PROTOCOL_BODY_OVERLAY_DENYLIST.has(key))

const bodyWithOverlay = <Body>(body: Body, request: LLMRequest, encodeBody: (body: Body) => string) =>
  Effect.gen(function* () {
    if (request.http?.body === undefined) return { jsonBody: body, bodyText: encodeBody(body) }
    const forbiddenKeys = forbiddenBodyOverlayKeys(request.http.body)
    if (forbiddenKeys.length > 0)
      return yield* ProviderShared.invalidRequest(
        `http.body cannot overlay protocol-owned field(s): ${forbiddenKeys.join(", ")}`,
      )
    if (ProviderShared.isRecord(body)) {
      const overlaid = mergeJsonRecords(body, request.http.body) ?? {}
      return { jsonBody: overlaid, bodyText: ProviderShared.encodeJson(overlaid) }
    }
    return yield* ProviderShared.invalidRequest("http.body can only overlay JSON object request bodies")
  })

export const jsonRequestParts = <Body>(input: JsonRequestInput<Body>) =>
  Effect.gen(function* () {
    const url = applyQuery(
      renderEndpoint(input.endpoint, { request: input.request, body: input.body }).toString(),
      input.request.http?.query,
    )
    const body = yield* bodyWithOverlay(input.body, input.request, input.encodeBody)
    const headers = yield* Auth.toEffect(input.auth)({
      request: input.request,
      method: "POST",
      url,
      body: body.bodyText,
      headers: Headers.fromInput({
        ...input.headers?.({ request: input.request }),
        ...input.request.http?.headers,
      }),
    })
    return { url, jsonBody: body.jsonBody, bodyText: body.bodyText, headers }
  })

export interface HttpJsonInput<_Body, Frame> {
  readonly framing: FramingDef<Frame>
}

export type HttpJsonPatch<Body, Frame> = Partial<HttpJsonInput<Body, Frame>>

export interface HttpJsonTransport<Body, Frame> extends Transport<Body, HttpPrepared<Frame>, Frame> {
  readonly with: (patch: HttpJsonPatch<Body, Frame>) => HttpJsonTransport<Body, Frame>
}

export const httpJson = <Body, Frame>(input: HttpJsonInput<Body, Frame>): HttpJsonTransport<Body, Frame> => ({
  id: "http-json",
  with: (patch) => httpJson({ ...input, ...patch }),
  prepare: (prepareInput) =>
    jsonRequestParts({
      ...prepareInput,
    }).pipe(
      Effect.map((parts) => ({
        request: ProviderShared.jsonPost({ url: parts.url, body: parts.bodyText, headers: parts.headers }),
        framing: input.framing,
      })),
    ),
  frames: (prepared, request, runtime) =>
    Stream.unwrap(
      runtime.http.execute(prepared.request).pipe(
        Effect.map((response) => {
          let receivedFrame = false
          const accepted = Date.now()
          const requestID = response.headers["x-generation-id"] ?? response.headers["x-request-id"]
          const timeout = (kind: string, message: string) =>
            Stream.fail(
              new LLMError({
                module: "HttpTransport",
                method: "frames",
                reason: new TransportReason({
                  kind,
                  message: `${message}${requestID ? ` (request: ${requestID})` : ""}`,
                }),
              }),
            )
          // These clocks start only after response headers arrive. Request
          // establishment and its bounded retries are owned by the executor.
          return prepared.framing
            .frame(
              response.stream.pipe(
                Stream.mapError((error) =>
                  ProviderShared.eventError(
                    `${request.model.provider}/${request.model.route.id}`,
                    `Failed to read ${request.model.provider}/${request.model.route.id} stream`,
                    ProviderShared.errorText(error),
                  ),
                ),
                Stream.timeoutOrElse({
                  duration: "120 seconds",
                  orElse: () =>
                    timeout("StreamIdle", "模型连接已建立，但连续 120 秒未收到网络数据；请求已停止，未自动重放工具。"),
                }),
              ),
            )
            .pipe(
              Stream.tap(() =>
                Effect.suspend(() => {
                  if (receivedFrame) return Effect.void
                  receivedFrame = true
                  return Effect.logInfo("provider.response.first_frame", {
                    requestID,
                    elapsedMs: Date.now() - accepted,
                  })
                }),
              ),
              Stream.timeoutOrElse({
                duration: "180 seconds",
                orElse: () =>
                  timeout(
                    receivedFrame ? "ProgressTimeout" : "FirstEventTimeout",
                    receivedFrame
                      ? "模型响应连续 180 秒没有新的有效数据；请求已停止，已执行的操作不会自动重放。"
                      : "模型连接已建立，但 180 秒内没有有效响应（保活消息不算输出）；请求已停止。",
                  ),
              }),
              Stream.concat(
                Stream.unwrap(
                  Effect.sync(() =>
                    receivedFrame
                      ? Stream.empty
                      : Stream.fail(
                          ProviderShared.eventError(request.model.route.id, "模型连接已结束，但没有返回有效响应。"),
                        ),
                  ),
                ),
              ),
              Stream.ensuring(
                Effect.suspend(() =>
                  Effect.logInfo("provider.response.closed", {
                    requestID,
                    elapsedMs: Date.now() - accepted,
                    receivedFrame,
                  }),
                ),
              ),
            )
        }),
      ),
    ),
})

export const sseJson = {
  id: "http-json/sse",
  with: <Body>() => httpJson<Body, string>({ framing: Framing.sse }),
} as const
