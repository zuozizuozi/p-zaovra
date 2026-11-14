import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM } from "../src"
import { Auth, RequestExecutor } from "../src/route"
import { OpenAIResponses } from "../src/protocols/openai-responses"
import { testEffect } from "./lib/effect"
import { runtimeLayer } from "./lib/http"
import { sseEvents } from "./lib/sse"

const http = testEffect(runtimeLayer(FetchHttpClient.layer))
const capture = (bodies: Record<string, unknown>[]) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          bodies.push((await request.json()) as Record<string, unknown>)
          return new Response(
            sseEvents({
              type: "response.completed",
              response: { id: "local-response", status: "completed", output: [] },
            }),
          )
        },
      }),
    ),
    (server) => Effect.sync(() => server.stop(true)),
  )

for (const source of ["route", "model", "request"] as const)
  http.live(`rejects Responses max_output_tokens from ${source} overlays before admission or HTTP`, () =>
    Effect.gen(function* () {
      const bodies: Record<string, unknown>[] = []
      const admissions: string[] = []
      const server = yield* capture(bodies)
      const overlay = { body: { max_output_tokens: 4096 } }
      const model = OpenAIResponses.route
        .with({
          endpoint: { baseURL: server.url.href },
          auth: Auth.bearer("local-fixture"),
          http: source === "route" ? overlay : undefined,
        })
        .model({ id: "output-limit", defaults: source === "model" ? { http: overlay } : undefined })
      const result = yield* LLM.generate(
        LLM.request({
          model,
          prompt: "hello",
          generation: { maxTokens: 32 },
          http: source === "request" ? overlay : undefined,
        }),
      ).pipe(
        Effect.provideService(RequestExecutor.RequestAdmission, ({ id }) =>
          Effect.sync(() => {
            admissions.push(id)
          }),
        ),
        Effect.exit,
      )
      expect(bodies).toEqual([])
      expect(admissions).toEqual([])
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isSuccess(result)) throw new Error("Protocol-owned overlay was accepted")
      expect(Cause.findErrorOption(result.cause)).toMatchObject({
        value: {
          reason: {
            _tag: "InvalidRequest",
            message: "http.body cannot overlay protocol-owned field(s): max_output_tokens",
          },
        },
      })
    }),
  )

http.live("keeps the generation output limit and legal custom extensions on the real Responses wire", () =>
  Effect.gen(function* () {
    const bodies: Record<string, unknown>[] = []
    const server = yield* capture(bodies)
    yield* LLM.generate(
      LLM.request({
        model: OpenAIResponses.route
          .with({ endpoint: { baseURL: server.url.href }, auth: Auth.bearer("local-fixture") })
          .model({ id: "output-limit" }),
        prompt: "hello",
        generation: { maxTokens: 32 },
        http: { body: { metadata: { audit: "local" }, custom_extension: true } },
      }),
    )
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({
      model: "output-limit",
      max_output_tokens: 32,
      metadata: { audit: "local" },
      custom_extension: true,
    })
  }),
)
