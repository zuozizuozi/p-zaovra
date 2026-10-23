import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionMessage } from "@zaovra-ai/schema/session-message"
import { SessionOutcome } from "@zaovra-ai/core/session/outcome"
import { createZaovraClient } from "@zaovra-ai/sdk/v2"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

describe("zaovra run verbatim input", () => {
  for (const fixture of [
    {
      name: "quotes and shell literals",
      text: "Keep \"double quotes\", 'single quotes', C:\\two words\\file and $(echo literal)",
      clauses: 1,
    },
    { name: "newlines", text: 'Keep "quoted text"\nKeep the second line', clauses: 2 },
    { name: "trailing newline", text: 'Keep "quoted text"\nKeep the second line\n', clauses: 2 },
  ])
    cliIt.live(
      `persists ${fixture.name} without extra clauses`,
      ({ home, llm, zaovra }) =>
        Effect.gen(function* () {
          yield* llm.text("Fixed local response")
          const server = yield* zaovra.serve()
          const client = createZaovraClient({ baseUrl: server.url, directory: home })
          const session = yield* Effect.promise(() =>
            client.v2.session
              .create({ location: { directory: home } }, { throwOnError: true })
              .then((result) => result.data.data),
          )
          const result = yield* zaovra.run(fixture.text, {
            extraArgs: ["--attach", server.url, "--session", session.id],
          })
          zaovra.expectExit(result, 0)
          const history = yield* Effect.promise(() =>
            client.v2.session.messages({ sessionID: session.id }, { throwOnError: true }),
          )
          const messages = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Message))(history.data.data)
          const users = messages.filter((message) => message.type === "user")
          expect(users).toHaveLength(1)
          expect(users[0].text).toBe(fixture.text)
          expect(SessionOutcome.requested(messages).clauses).toHaveLength(fixture.clauses)
          expect(yield* llm.calls).toBe(1)
        }),
      60_000,
    )

  cliIt.live(
    "joins positional and double-dash arguments without quoting them",
    ({ llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.text("Fixed local response")
        const result = yield* zaovra.spawn([
          "run",
          "--model",
          "test/test-model",
          'Keep "first phrase"',
          "--",
          "second phrase",
          "--literal",
        ])
        zaovra.expectExit(result, 0)
        expect(JSON.stringify(yield* llm.inputs)).toContain(
          JSON.stringify('Keep "first phrase" second phrase --literal').slice(1, -1),
        )
        expect(yield* llm.calls).toBe(1)
      }),
    60_000,
  )

  cliIt.live(
    "expands command arguments without adding prompt quotes",
    ({ llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.text("Fixed local response")
        const result = yield* zaovra.run('Keep "quoted text"', {
          command: "verbatim",
          env: {
            ZAOVRA_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              command: { verbatim: { template: "Instruction: $ARGUMENTS" } },
            }),
          },
        })
        zaovra.expectExit(result, 0)
        expect(JSON.stringify(yield* llm.inputs)).toContain(
          JSON.stringify('Instruction: Keep "quoted text"').slice(1, -1),
        )
        expect(yield* llm.calls).toBe(1)
      }),
    60_000,
  )
})
