import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { LLM, Message } from "../../src"
import { LLMClient } from "../../src/route"
import { OpenAIResponses } from "../../src/protocols/openai-responses"
import { testEffect } from "../lib/effect"
import { dynamicResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

for (const modelID of ["deepseek-v4.1-flash-1017", "gpt-6-luna"]) {
  const bodies: OpenAIResponses.OpenAIResponsesBody[] = []
  const it = testEffect(
    dynamicResponse((input) =>
      Effect.gen(function* () {
        const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIResponses.protocol.body.schema))(
          input.text,
        ).pipe(Effect.orDie)
        bodies.push(body)
        const roles = body.input.filter((item) => "role" in item)
        expect(roles.length).toBeGreaterThanOrEqual(2)
        expect(roles.every((item) => "type" in item && item.type === "message")).toBe(true)
        return input.respond(
          sseEvents(
            { type: "response.output_text.delta", item_id: "msg_fixture", delta: "OK" },
            { type: "response.completed", response: { id: "resp_fixture" } },
          ),
          { headers: { "content-type": "text/event-stream" } },
        )
      }),
    ),
  )
  it.effect(`560 ${modelID}: three HTTP-encoded rounds retain explicit message tags and text/image roles`, () =>
    Effect.gen(function* () {
      const model = OpenAIResponses.route
        .with({ endpoint: { baseURL: "https://responses.fixture.test/v1" } })
        .model({ id: modelID })
      const first = yield* LLMClient.generate(
        LLM.request({ model, system: "Local fixture", messages: [Message.user("Round 1")] }),
      )
      const secondHistory = [
        Message.user("Round 1"),
        Message.assistant(first.text),
        Message.user("Round 2"),
        Message.system("Updated local instruction"),
      ]
      const second = yield* LLMClient.generate(LLM.request({ model, system: "Local fixture", messages: secondHistory }))
      yield* LLMClient.generate(
        LLM.request({
          model,
          system: "Local fixture",
          messages: [
            ...secondHistory,
            Message.assistant(second.text),
            Message.user([
              { type: "text", text: "Round 3" },
              { type: "media", mediaType: "image/png", data: "AAECAw==" },
            ]),
          ],
        }),
      )
      expect(bodies).toHaveLength(3)
      expect(bodies[1]!.input.filter((item) => "role" in item && item.role === "assistant")).toEqual([
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] },
      ])
      expect(bodies[2]!.input.filter((item) => "role" in item && item.role === "assistant")).toHaveLength(2)
      const last = bodies[2]!.input.at(-1)
      expect(last && "role" in last && last.role === "user" ? last.content.map((part) => part.type) : []).toEqual([
        "input_text",
        "input_image",
      ])
    }),
  )
}

const it = testEffect(Layer.empty)
it.effect("560 wire schema accepts explicitly tagged system/developer/user/assistant items", () =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(OpenAIResponses.protocol.body.schema)({
      model: "fixture",
      stream: true,
      input: [
        { type: "message", role: "system", content: "system" },
        { type: "message", role: "developer", content: "developer" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "user" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "assistant" }] },
      ],
    })
    expect(body.input.map((item) => ("type" in item ? item.type : undefined))).toEqual([
      "message",
      "message",
      "message",
      "message",
    ])
    expect(body.input.map((item) => ("role" in item ? item.role : undefined))).toEqual([
      "system",
      "developer",
      "user",
      "assistant",
    ])
  }),
)
