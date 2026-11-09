import { expect, test } from "bun:test"
import { HttpClientRequest } from "effect/unstable/http"
import { Effect, Layer } from "effect"
import { LLMError, InvalidRequestReason } from "@zaovra-ai/llm"
import { RequestExecutor } from "@zaovra-ai/llm/route"
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
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionProjector } from "@zaovra-ai/core/session/projector"
import { SessionStore } from "@zaovra-ai/core/session/store"
import { ProviderDiagnostics } from "@zaovra-ai/core/session/provider-diagnostics"
import { SessionRetry } from "@zaovra-ai/core/session/retry"
import { createLLMEventPublisher } from "@zaovra-ai/core/session/runner/publish-llm-event"
import { dynamicResponse } from "../../llm/test/lib/http"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
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
  ),
)

for (const path of ["http", "sse"] as const)
  it.effect(`776 ${path} provider diagnostics persist with an actionable request error`, () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const created = yield* session.create({
        location: Location.Ref.make({ directory: AbsolutePath.make("/synthetic") }),
      })
      const publisher = createLLMEventPublisher(events, {
        sessionID: created.id,
        agent: "build",
        model: { id: ModelV2.ID.make("synthetic"), providerID: ProviderV2.ID.make("synthetic") },
        inputSequence: 0,
        contextEpoch: 0,
      })
      const message = 'cipher rejected; api_key="SYNTHETIC_SECRET_776"'
      if (path === "sse") {
        yield* publisher.publish({ type: "provider-error", code: "invalid_encrypted_content", message, status: 400 })
      } else {
        const error = yield* RequestExecutor.Service.use((executor) =>
          executor.execute(
            HttpClientRequest.post("https://synthetic.invalid/responses").pipe(
              HttpClientRequest.bearerToken("synthetic-auth-776"),
            ),
          ),
        ).pipe(
          Effect.provide(
            dynamicResponse(({ respond }) =>
              Effect.sync(() =>
                respond(JSON.stringify({ error: { code: "invalid_encrypted_content", message } }), {
                  status: 400,
                  headers: { "x-request-id": "req_776", "set-cookie": "SYNTHETIC_COOKIE_776" },
                }),
              ),
            ),
          ),
          Effect.provideService(RequestExecutor.AutomaticRetries, false),
          Effect.flip,
        )
        expect(error.reason._tag).toBe("InvalidRequest")
        const decision = SessionRetry.decide({
          error,
          attempt: 0,
          committed: false,
          operations: "settled",
          cancelled: false,
          remainingMs: 120_000,
        })
        expect(decision.action).toBe("stop")
        if (decision.action !== "stop") throw new Error("Unexpected retry")
        yield* publisher.failAssistant(decision.message, {
          category: error.reason._tag,
          statusCode: "400",
          ...ProviderDiagnostics.metadata(error),
        })
      }
      const history = yield* store.runnerContext(created.id, 0)
      const assistant = history.find((item) => item.type === "assistant")
      if (assistant?.type !== "assistant") throw new Error("Missing assistant")
      expect(assistant.error?.metadata).toMatchObject({
        category: "InvalidRequest",
        statusCode: "400",
        providerCode: "invalid_encrypted_content",
        providerMessage: expect.stringContaining("cipher rejected"),
      })
      const diagnostic = JSON.stringify(assistant.error?.metadata)
      expect(diagnostic).not.toContain("SYNTHETIC_SECRET_776")
      expect(diagnostic).not.toContain("SYNTHETIC_COOKIE_776")
      expect(diagnostic).not.toContain("synthetic-auth-776")
      expect(diagnostic).not.toContain("responseBody")
      expect(assistant.error?.message).toStartWith(SessionRetry.invalidRequestMessage)
      expect(assistant.error?.message.split(SessionRetry.invalidRequestMessage)).toHaveLength(2)
      expect(assistant.error?.message).not.toContain("修正请求")
      if (path === "http") expect(assistant.error?.metadata?.requestID).toBe("req_776")
    }),
  )

testEffect(Layer.empty).effect("776 generic HTTP 400 has a summary but never invents an encrypted-content code", () =>
  Effect.gen(function* () {
    const error = yield* RequestExecutor.Service.use((executor) =>
      executor.execute(HttpClientRequest.post("https://synthetic.invalid")),
    ).pipe(
      Effect.provide(
        dynamicResponse(({ respond }) =>
          Effect.sync(() => respond(JSON.stringify({ error: { message: "generic rejection" } }), { status: 400 })),
        ),
      ),
      Effect.provideService(RequestExecutor.AutomaticRetries, false),
      Effect.flip,
    )
    expect(ProviderDiagnostics.metadata(error)).toEqual({
      providerMessage: expect.stringContaining("generic rejection"),
    })
  }),
)

test("776 local failures do not become provider diagnostics", () => {
  expect(
    ProviderDiagnostics.metadata(
      new LLMError({
        module: "Provider",
        method: "request",
        reason: new InvalidRequestReason({ message: "local failure" }),
      }),
    ),
  ).toEqual({})
})
