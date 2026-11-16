export * as MemoryTidyExecution from "./tidy-execution"

import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
  InvalidRequestReason,
  LLM,
  LLMError,
  QuotaExceededReason,
  type LLMEvent,
  type LLMRequest,
} from "@zaovra-ai/llm"
import { RequestExecutor } from "@zaovra-ai/llm/route"
import { OpenAIResponses } from "@zaovra-ai/llm/protocols/openai-responses"
import { Memory } from "@zaovra-ai/schema/memory"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { Location } from "../location"
import type { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { SessionRunnerModel } from "../session/runner/model"
import { SessionOutputRecovery } from "../session/output-recovery"
import { MemoryStore } from "./store"
import { MemoryTidyBudget } from "./tidy-budget"
import { MemoryTidyStore } from "./tidy-store"
import { MemoryAutomaticIdle } from "./automatic-idle"

export interface Interface {
  /** Bound actual generation before encoding, leaving ordinary requests unchanged. */
  readonly prepare: (sessionID: SessionSchema.ID, request: LLMRequest) => Effect.Effect<LLMRequest, LLMError>
  /** Wrap the existing single provider call, including compaction calls. */
  readonly wrap: (
    sessionID: SessionSchema.ID,
    request: LLMRequest,
    stream: Stream.Stream<LLMEvent, LLMError>,
  ) => Stream.Stream<LLMEvent, LLMError>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/MemoryTidyExecution") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* MemoryTidyStore.Service
    const memory = yield* MemoryStore.Service
    const budget = yield* MemoryTidyBudget.Service
    const sessions = yield* SessionStore.Service
    const models = yield* SessionRunnerModel.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const http = yield* HttpClient.HttpClient
    const idle = yield* MemoryAutomaticIdle.Service

    const authority = Effect.fn("MemoryTidyExecution.authority")(function* (
      run: MemoryTidyStore.Run,
      request: LLMRequest,
    ) {
      if (
        run.directory !== location.directory ||
        (run.scope !== Memory.Scope.user &&
          run.scope !== (yield* memory.scope({ project: location.project.id, directory: location.directory })))
      )
        return yield* denied("整理任务的目录或记忆范围已经改变。")
      const input = {
        sessionID: run.session_id,
        scope: run.scope,
        enabled: Config.latest(yield* config.entries(), "memory")?.enabled !== false,
      }
      yield* store.authorize(input).pipe(Effect.mapError(() => denied("整理授权已失效，未发送模型请求。")))
      if (!(yield* idle.allows(run))) return yield* denied("应用有其他待处理任务，自动整理已暂停，未发送模型请求。")
      const session = yield* sessions.get(run.session_id)
      if (!session) return yield* denied("整理会话不存在。")
      // Resolve the current catalog alias and variant again. Matching the wire
      // to its own request model is insufficient when the catalog route changed.
      const current = yield* models.resolve(session).pipe(Effect.mapError(() => denied("整理模型当前不可用。")))
      if (
        current.id !== request.model.id ||
        current.provider !== request.model.provider ||
        current.route.protocol !== request.model.route.protocol ||
        current.route.body !== request.model.route.body ||
        current.route.transport !== request.model.route.transport ||
        SessionOutputRecovery.identity(current) !== SessionOutputRecovery.identity(request.model) ||
        current.route.endpoint.baseURL !== request.model.route.endpoint.baseURL ||
        current.route.endpoint.path !== request.model.route.endpoint.path
      )
        return yield* denied("整理模型的实际线路已经改变，请重新确认整理任务。")
      return input
    })

    return Service.of({
      prepare: Effect.fn("MemoryTidyExecution.prepare")(function* (sessionID, request) {
        const run = yield* store.forSession(sessionID)
        if (!run) return request
        yield* authority(run, request)
        const remaining = run.token_limit - (yield* store.usage({ runID: run.id })).charged
        if (remaining <= 0)
          return yield* new LLMError({
            module: "MemoryTidyExecution",
            method: "prepare",
            reason: new QuotaExceededReason({ message: "本次整理预算已用完，未发送请求。" }),
          })
        const requested =
          request.generation?.maxTokens ??
          request.model.defaults?.generation?.maxTokens ??
          request.model.route.defaults.generation?.maxTokens ??
          request.model.route.defaults.limits?.output ??
          4096
        if (!Number.isSafeInteger(requested) || requested <= 0) return yield* denied("整理模型的输出上限无效。")
        // This is an explicit output ceiling, not an estimate of input tokens.
        // Admission still counts the complete final input and reserves both.
        return LLM.updateRequest(request, {
          generation: { ...request.generation, maxTokens: Math.min(requested, remaining) },
        })
      }),
      wrap: (sessionID, request, stream) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const run = yield* store.forSession(sessionID)
            if (!run) return stream
            yield* authority(run, request)
            // A transport without an executor admission hook cannot participate
            // in the budget contract. Do not fall back to an unmetered stream.
            if (
              request.model.route.protocol !== "openai-responses" ||
              request.model.route.transport !== OpenAIResponses.httpTransport ||
              request.model.route.body !== OpenAIResponses.route.body ||
              request.model.route.endpoint.path !== OpenAIResponses.PATH
            )
              return yield* denied("这条整理模型线路尚不支持完整输入精确计数，未发送生成请求。")
            const previousAdmission = yield* RequestExecutor.RequestAdmission
            const previousCompletion = yield* RequestExecutor.RequestCompletion
            const fetchOptions = yield* Effect.serviceOption(FetchHttpClient.RequestInit)
            return stream.pipe(
              Stream.provideService(RequestExecutor.RequestAdmission, (attempt) =>
                Effect.gen(function* () {
                  yield* previousAdmission(attempt)
                  yield* authority(run, request)
                  const output = MemoryTidyBudget.wireLimit(request, attempt.request, run.token_limit)
                  if (!output) return yield* denied("整理请求缺少有效输出上限，或包含未授权的线路/服务端操作。")
                  const counted = yield* count(http, attempt.request)
                  // Counting is asynchronous. Recheck revocation, the selected
                  // model and current config before recording the reservation.
                  const current = yield* authority(run, request)
                  yield* budget.admit({
                    authority: current,
                    id: attempt.id,
                    request,
                    wire: attempt.request,
                    inputLimit: counted,
                    outputLimit: output,
                  })
                }),
              ),
              Stream.provideService(RequestExecutor.RequestCompletion, (receipt) =>
                budget.complete(run.id, receipt).pipe(Effect.andThen(previousCompletion(receipt))),
              ),
              Stream.provideService(FetchHttpClient.RequestInit, {
                ...Option.getOrElse(fetchOptions, () => ({})),
                redirect: "error",
              }),
            )
          }),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    MemoryTidyStore.node,
    MemoryStore.node,
    MemoryTidyBudget.node,
    MemoryAutomaticIdle.node,
    SessionStore.node,
    SessionRunnerModel.node,
    Config.node,
    Location.node,
    LayerNodePlatform.httpClient,
  ],
})

/**
 * The Responses count contract includes instructions, tools and replay data.
 * Never substitute visible-text estimates or a caller-provided catalog limit.
 * https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count
 */
const count = Effect.fn("MemoryTidyExecution.count")(function* (
  http: HttpClient.HttpClient,
  wire: HttpClientRequest.HttpClientRequest,
) {
  if (wire.body._tag !== "Uint8Array") return yield* denied("无法核对整理请求的完整输入。")
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(new TextDecoder().decode(wire.body.body))
  if (Option.isNone(parsed)) return yield* denied("无法核对整理请求的完整输入。")
  const body = Schema.decodeUnknownOption(OpenAIResponses.route.body.schema, { onExcessProperty: "error" })(
    parsed.value,
  )
  if (Option.isNone(body)) return yield* denied("整理请求不符合完整输入计数合同。")
  // Remote image contents may change between count and generation. Stored item
  // references also do not provide a self-contained input snapshot here.
  if (
    body.value.input.some(
      (item) =>
        item.type === "item_reference" ||
        (item.type === "message" &&
          Array.isArray(item.content) &&
          item.content.some((part) => part.type === "input_image" && !part.image_url.startsWith("data:"))) ||
        (item.type === "function_call_output" &&
          Array.isArray(item.output) &&
          item.output.some((part) => part.type === "input_image" && !part.image_url.startsWith("data:"))),
    )
  )
    return yield* denied("整理输入含有无法固定的远端内容，无法保证计数与实际请求一致。")
  const counting = yield* HttpClientRequest.post(`${wire.url}/input_tokens`, {
    headers: Headers.set(
      Headers.removeMany(wire.headers, ["content-length", "content-type", "idempotency-key"]),
      "accept",
      "application/json",
    ),
  }).pipe(
    HttpClientRequest.bodyJson({
      model: body.value.model,
      input: body.value.input,
      instructions: body.value.instructions,
      tools: body.value.tools,
      tool_choice: body.value.tool_choice,
      reasoning: body.value.reasoning,
      text: body.value.text,
    }),
    Effect.mapError(() => denied("无法编码整理输入计数请求。")),
  )
  return yield* Effect.gen(function* () {
    const response = yield* http.execute(counting)
    if (response.status !== 200) return yield* denied("模型线路未能提供精确输入计数，未发送生成请求。")
    const value = yield* response.json
    const decoded = Schema.decodeUnknownOption(
      Schema.Struct({ object: Schema.Literal("response.input_tokens"), input_tokens: Schema.Number }),
    )(value)
    if (Option.isNone(decoded) || !Number.isSafeInteger(decoded.value.input_tokens) || decoded.value.input_tokens <= 0)
      return yield* denied("模型线路返回的输入计数无效，未发送生成请求。")
    return decoded.value.input_tokens
  }).pipe(
    Effect.timeout("20 seconds"),
    Effect.mapError(() => denied("无法取得完整输入的精确计数，未发送生成请求。")),
  )
})

function denied(message: string) {
  return new LLMError({ module: "MemoryTidyExecution", method: "wrap", reason: new InvalidRequestReason({ message }) })
}
