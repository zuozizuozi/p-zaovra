import { expect, test } from "bun:test"
import { Clock, DateTime, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { RequestExecutor } from "@zaovra-ai/llm/route"
import { Feedback } from "@zaovra-ai/schema/feedback"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { Location } from "@zaovra-ai/core/location"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionSchema } from "@zaovra-ai/core/session/schema"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionProjector } from "@zaovra-ai/core/session/projector"
import { SessionStore } from "@zaovra-ai/core/session/store"
import { ProviderDiagnostics } from "@zaovra-ai/core/session/provider-diagnostics"
import { SessionRetry } from "@zaovra-ai/core/session/retry"
import { createLLMEventPublisher } from "@zaovra-ai/core/session/runner/publish-llm-event"
import { adaptSessionMessages } from "../context/v2-session-adapter"
import { sessionFeedback } from "./feedback-session"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
  [
    [Database.node, Database.layerFromPath(":memory:")],
    [
      ProjectV2.node,
      Layer.succeed(
        ProjectV2.Service,
        ProjectV2.Service.of({
          resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
          directories: () => Effect.succeed([]),
          commit: () => Effect.void,
        }),
      ),
    ],
    [SessionExecution.node, SessionExecution.noopLayer],
  ],
)

for (const path of ["http", "sse"] as const)
  test(`793 ${path} durable diagnostics reach the App report with opt-in boundaries intact`, () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const created = yield* session.create({
        location: Location.Ref.make({ directory: AbsolutePath.make("/synthetic793") }),
      })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID: created.id,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        prompt: { text: "Controlled diagnostic projection" },
        delivery: "steer",
      })
      const input = {
        sessionID: created.id,
        agent: "build",
        model: { id: ModelV2.ID.make("synthetic"), providerID: ProviderV2.ID.make("synthetic") },
        inputSequence: 0,
        contextEpoch: 0,
      }
      const publisher = createLLMEventPublisher(events, input)
      const message = 'cipher rejected; api_key="SYNTHETIC_SECRET_793"'
      if (path === "sse") {
        // A decoded SSE provider-error enters the actual durable event publisher.
        yield* publisher.publish({ type: "provider-error", code: "invalid_encrypted_content", message, status: 400 })
      }
      if (path === "http") {
        const requests: string[] = []
        const error = yield* RequestExecutor.Service.use((executor) =>
          executor.execute(HttpClientRequest.post("https://synthetic.invalid/responses")),
        ).pipe(
          Effect.provide(
            RequestExecutor.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  HttpClient.HttpClient,
                  // Happy DOM's URL lacks the native static parser; only the fixed transport skips URL resolution.
                  HttpClient.makeWith(
                    (request: Effect.Effect<HttpClientRequest.HttpClientRequest, HttpClientError.HttpClientError>) =>
                      Effect.map(request, (value) => {
                        requests.push(value.url)
                        return HttpClientResponse.fromWeb(
                          value,
                          new Response(
                            JSON.stringify({
                              error: { code: "invalid_encrypted_content", message, payload: "PRIVATE_JSON_793" },
                            }),
                            {
                              status: 400,
                              headers: { "x-request-id": "req_793", "set-cookie": "SYNTHETIC_COOKIE_793" },
                            },
                          ),
                        )
                      }),
                    Effect.succeed,
                  ),
                ),
              ),
            ),
          ),
          Effect.provideService(RequestExecutor.AutomaticRetries, false),
          Effect.flip,
        )
        expect(requests).toEqual(["https://synthetic.invalid/responses"])
        expect(error.reason._tag).toBe("InvalidRequest")
        const decision = SessionRetry.decide({
          error,
          attempt: 0,
          committed: false,
          operations: "settled",
          cancelled: false,
          remainingMs: 120_000,
        })
        if (decision.action !== "stop") throw new Error(`Unexpected retry: ${JSON.stringify(error)}`)
        yield* publisher.failAssistant(`${decision.message}\n${error.reason.message}`, {
          category: error.reason._tag,
          statusCode: "400",
          ...ProviderDiagnostics.metadata(error),
        })
      }
      yield* createLLMEventPublisher(events, input).failAssistant("HTTP 400", { statusCode: "400" })
      // Reload the persisted rows, encode with the production wire schemas, then use the actual App adapter.
      const history = yield* store.runnerContext(created.id, 0)
      const wire = Schema.encodeSync(Schema.Array(SessionMessage.Message))(history)
      const rows = adaptSessionMessages(
        Schema.encodeSync(SessionSchema.Info)(created) as Parameters<typeof adaptSessionMessages>[0],
        wire as Parameters<typeof adaptSessionMessages>[1],
      )
      const assistants = rows.filter((row) => row.message.role === "assistant")
      expect(assistants).toHaveLength(2)
      const first = assistants[0].message
      if (first.role !== "assistant" || first.error?.name !== "APIError") throw new Error("Missing adapted APIError")
      expect(first.error.data.metadata?.providerMessageSource).toBe("structured")
      expect(first.error.data.message).toContain("cipher rejected")
      const now = yield* Clock.currentTimeMillis
      const collected = sessionFeedback(
        rows.map((row) => row.message),
        (id) => rows.find((row) => row.message.id === id)?.parts ?? [],
        now,
      )
      expect(collected.context.errors[0]).toMatchObject({ providerMessageSource: "structured" })
      const snapshot = Feedback.snapshot({
        now,
        description: "Controlled feedback",
        context: collected.context,
        include: { environment: false, events: false, errors: true },
      })
      const report = JSON.parse(snapshot.text)
      expect(report.errors).toHaveLength(2)
      expect(report.errors[0]).toMatchObject({
        status: 400,
        providerCode: "invalid_encrypted_content",
        providerMessage: expect.stringContaining("cipher rejected"),
      })
      if (path === "http") expect(report.errors[0].requestID).toBe("req_793")
      expect(report.errors[1].status).toBe(400)
      expect(report.errors[1]).not.toHaveProperty("providerCode")
      expect(report.errors[1]).not.toHaveProperty("providerMessage")
      expect(snapshot.files.map((file) => file.name)).toEqual(["report.json"])
      for (const marker of [
        "SYNTHETIC_SECRET_793",
        "SYNTHETIC_COOKIE_793",
        "PRIVATE_JSON_793",
        SessionRetry.invalidRequestMessage,
      ])
        expect(Feedback.copy(snapshot)).not.toContain(marker)
      const excluded = Feedback.snapshot({
        now,
        description: "",
        context: collected.context,
        include: { environment: false, events: false, errors: false },
      })
      expect(JSON.parse(excluded.text)).not.toHaveProperty("errors")
      expect(excluded.files.map((file) => file.name)).toEqual(["report.json"])
      const details = Feedback.snapshot({
        now,
        description: "Controlled feedback",
        context: collected.context,
        include: { environment: false, events: false, errors: true },
        details: first.error.data.message,
      })
      expect(JSON.parse(details.text)).toEqual({ ...report, reportID: expect.any(String) })
      expect(details.files.map((file) => file.name)).toEqual(["report.json", "details.txt"])
      expect(details.files[1].text).toContain(SessionRetry.invalidRequestMessage)
      expect(details.files[1].text).toContain("cipher rejected")
      expect(Feedback.copy(details)).not.toContain("SYNTHETIC_SECRET_793")
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise))
