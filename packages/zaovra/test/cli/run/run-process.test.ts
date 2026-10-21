// Subprocess integration tests for `zaovra run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `zaovra.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `ZAOVRA_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"
import { createZaovraClient } from "@zaovra-ai/sdk/v2"

describe("zaovra run (non-interactive subprocess)", () => {
  cliIt.live(
    "S1 background completion wakes the same session and continues once",
    ({ home, llm, zaovra }) =>
      Effect.gen(function* () {
        const script = `${home}/background.cjs`
        yield* Effect.promise(() => Bun.write(script, 'setTimeout(() => console.log("background-complete"), 2000)'))
        yield* llm.push(
          reply().tool("bash", {
            command: `bun "${script}"`,
            description: "Fixed background fixture",
            run_in_background: true,
          }),
          reply().text("Waiting for the background job.").stop(),
          reply().text("Continued after durable completion notification.").stop(),
        )
        const result = yield* zaovra.run("Run once and continue when the job ends", {
          format: "json",
          extraArgs: ["--dangerously-skip-permissions"],
          env: {
            ZAOVRA_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              snapshot: false,
              experimental: { verification: false },
            }),
          },
        })
        expect(result.exitCode, result.stderr + result.stdout).toBe(0)
        expect(yield* llm.calls).toBe(3)
        expect(result.stdout).toContain("Continued after durable completion notification")
      }),
    60_000,
  )
  for (const mode of ["queue", "interrupt"] as const)
    cliIt.live(
      `V5 attached CLI observes host ${mode} before exit`,
      ({ home, llm, zaovra }) =>
        Effect.gen(function* () {
          const release = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
          yield* llm.push(
            reply().wait(release.promise).text("first-input-result").stop(),
            reply().text("queued-input-result").stop(),
          )
          const server = yield* zaovra.serve()
          const client = createZaovraClient({ baseUrl: server.url, directory: home })
          const session = yield* Effect.promise(() =>
            client.v2.session
              .create({ location: { directory: home } }, { throwOnError: true })
              .then((result) => result.data.data),
          )
          const run = yield* zaovra.startRun("first input", {
            format: "json",
            extraArgs: ["--attach", server.url, "--session", session.id],
          })
          yield* llm.wait(1)
          if (mode === "queue") {
            yield* Effect.promise(() =>
              client.v2.session.prompt(
                { sessionID: session.id, prompt: { text: "queued input" }, delivery: "queue" },
                { throwOnError: true },
              ),
            )
            release.resolve()
          } else {
            yield* Effect.promise(() => client.v2.session.interrupt({ sessionID: session.id }, { throwOnError: true }))
            release.resolve()
          }
          const result = yield* run.result
          const outcome = yield* Effect.promise(() =>
            client.v2.session
              .outcome({ sessionID: session.id }, { throwOnError: true })
              .then((response) => response.data.data),
          )
          expect(result.exitCode).toBe(0)
          if (mode === "queue") {
            expect(result.stdout).toContain("queued-input-result")
            expect(yield* llm.calls).toBe(2)
            expect(outcome.state).toBe("completed")
          } else expect(outcome.state).toBe("interrupted")
        }),
      60_000,
    )
  cliIt.concurrent(
    "V5 waits for host closing after an intermediate provider stop",
    ({ llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().tool("bash", { command: "echo checked", description: "Inspect fixture" }),
          reply().text("intermediate-provider-stop").stop(),
          reply().text("final-host-closing-result").stop(),
        )
        const result = yield* zaovra.run("Check empty CSV round trips", {
          format: "json",
          extraArgs: ["--dangerously-skip-permissions"],
          env: {
            ZAOVRA_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              snapshot: false,
              experimental: { verification: true },
            }),
          },
        })
        expect(result.exitCode).toBe(0)
        expect(yield* llm.calls).toBe(3)
        expect(result.stdout).toContain("final-host-closing-result")
      }),
    60_000,
  )
  cliIt.live(
    "V5 drains more than 100 durable events and retains final output",
    ({ home, llm, zaovra }) =>
      Effect.gen(function* () {
        const file = `${home}/fixture.txt`
        yield* Effect.promise(() => Bun.write(file, "pagination fixture\n".repeat(60)))
        yield* llm.push(
          ...Array.from({ length: 55 }, (_, index) =>
            reply().tool("read", { path: file, offset: index + 1, limit: 1 }),
          ),
          reply().text("after-all-history-pages").stop(),
        )
        const result = yield* zaovra.run("Read the fixture", {
          format: "json",
          extraArgs: ["--dangerously-skip-permissions"],
          env: { ZAOVRA_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(llm.url), snapshot: false }) },
        })
        expect(result.exitCode).toBe(0)
        const events = zaovra.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "tool_result")).toHaveLength(55)
        expect(result.stdout).toContain("after-all-history-pages")
        expect(events.length).toBeGreaterThan(100)
      }),
    60_000,
  )

  cliIt.live(
    "V5 length recovery returns the completed answer",
    ({ llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().text("partial-answer").length(), reply().text("recovered-answer").stop())
        const result = yield* zaovra.run("Answer a question", { format: "json" })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain("recovered-answer")
        expect(yield* llm.calls).toBe(2)
      }),
    60_000,
  )

  cliIt.live(
    "S1 max steps emits final report and stopped exit 2",
    ({ llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().tool("bash", { command: "echo bounded", description: "Inspect" }),
          reply().text("max-steps-final-report").stop(),
        )
        const result = yield* zaovra.run("Inspect a file", {
          printLogs: true,
          format: "json",
          extraArgs: ["--dangerously-skip-permissions"],
          env: {
            ZAOVRA_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              snapshot: false,
              agent: { build: { steps: 2 } },
            }),
          },
        })
        expect(result.exitCode, result.stderr + result.stdout).toBe(2)
        expect(result.stdout).toContain("max-steps-final-report")
        expect(yield* llm.calls).toBe(2)
      }),
    60_000,
  )
  cliIt.concurrent(
    "exhausted text truncation exits nonzero after automatic continuation",
    ({ llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().text("first truncated output").length(), reply().text("still truncated").length())
        const result = yield* zaovra.run("finish the answer", { format: "json" })
        expect(result.exitCode).not.toBe(0)
        expect(yield* llm.calls).toBe(2)
        expect(result.stdout).toContain("still truncated")
      }),
    60_000,
  )
  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.concurrent(
    "exits 0 and writes the response to stdout on a successful prompt",
    ({ home, llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* zaovra.run("say hi")
        zaovra.expectExit(result, 0)
        expect(result.stdout).toBe("hello from the test llm\n")
        const input = JSON.stringify(yield* llm.inputs).replaceAll("\\\\", "/")
        expect(input).toContain(home.replaceAll("\\", "/"))
        expect(input).not.toContain("effect-smol")
      }),
    60_000,
  )

  cliIt.concurrent(
    "prints each completed text part in order around a tool continuation",
    ({ llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("  before tool  ").tool("bash", {
            command: "printf tool-output",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("  after tool  ")

        const result = yield* zaovra.run("use a tool", {
          extraArgs: ["--dangerously-skip-permissions"],
        })

        zaovra.expectExit(result, 0)
        expect(result.stdout).toBe("before tool\nafter tool\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "prints reasoning before text only with --thinking",
    ({ llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.reason("  considering  ", { text: "  answer  " })
        const thinking = yield* zaovra.run("think", { extraArgs: ["--thinking"] })
        zaovra.expectExit(thinking, 0)
        expect(thinking.stdout).toBe("Thinking: considering\nanswer\n")

        yield* llm.reason("hidden", { text: "visible" })
        const plain = yield* zaovra.run("think again")
        zaovra.expectExit(plain, 0)
        expect(plain.stdout).toBe("visible\n")
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error promptly so the process exits nonzero.
  // We assert nonzero exit AND wall-clock under the harness timeout — a hang
  // would expire the timeout and produce a different (signal-killed) failure.
  cliIt.concurrent(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ zaovra }) =>
      Effect.gen(function* () {
        const result = yield* zaovra.run("say hi", {
          model: "test/nonexistent-model",
          timeoutMs: 15_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(15_000)
      }),
    30_000,
  )

  // Provider failures preserve already-durable output but must surface a
  // non-zero process result instead of looking like a successful completion.
  cliIt.concurrent(
    "unknown stream finish preserves partial output and exits nonzero",
    ({ llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial response").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.fail("upstream provider exploded mid-stream")
        const result = yield* zaovra.run("trigger midstream error", { timeoutMs: 30_000 })
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).toBe("partial response\n")
        expect(result.stderr).not.toContain("upstream provider exploded mid-stream")
      }),
    60_000,
  )

  // --format json puts one JSON object per line on stdout for each emitted
  // event. Consumers (CI scripts, tooling) parse this stream. Asserts the
  // shape so a future event-emit change has to update this expectation.
  cliIt.concurrent(
    "--format json emits parseable line-delimited JSON to stdout",
    ({ llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.text("structured output")
        const result = yield* zaovra.run("say hi", { format: "json" })
        zaovra.expectExit(result, 0)

        const events = zaovra.parseJsonEvents(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        for (const evt of events) {
          expect(typeof evt.type).toBe("string")
          expect(typeof evt.sessionID).toBe("string")
        }
        expect(events.map((event) => event.type)).toEqual(["step_start", "text", "step_finish"])
        expect(events.map(({ timestamp: _, sessionID: __, ...event }) => event)).toEqual([
          {
            type: "step_start",
            event: expect.objectContaining({ type: "session.next.step.started" }),
          },
          {
            type: "text",
            event: expect.objectContaining({
              type: "session.next.text.ended",
              properties: expect.objectContaining({ text: "structured output" }),
            }),
          },
          {
            type: "step_finish",
            event: expect.objectContaining({ type: "session.next.step.ended" }),
          },
        ])
        expect(result.stdout.endsWith("\n")).toBe(true)
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.length > 0),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json emits the admitted step then a pure error record for an unknown model",
    ({ zaovra }) =>
      Effect.gen(function* () {
        const result = yield* zaovra.run("use an unknown model", {
          model: "test/nonexistent-model",
          format: "json",
        })

        expect(result.exitCode).not.toBe(0)
        const events = zaovra.parseJsonEvents(result.stdout)
        // V2 admits the prompt before model resolution; failure is a durable step event.
        expect(events.map((event) => event.type)).toEqual(["step_start", "error"])
        expect(events[0]).toMatchObject({
          type: "step_start",
          event: { type: "session.next.step.started" },
        })
        expect(events[1]).toEqual({
          type: "error",
          timestamp: expect.any(Number),
          sessionID: expect.any(String),
          error: expect.any(Object),
        })
        expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(2)
      }),
    30_000,
  )

  cliIt.concurrent(
    "--format json preserves reasoning, tool, and continuation ordering",
    ({ llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().reason("reasoning").text("before").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("after")

        const result = yield* zaovra.run("exercise json records", {
          format: "json",
          extraArgs: ["--thinking", "--dangerously-skip-permissions"],
        })

        expect(result.exitCode).toBe(0)
        const events = zaovra.parseJsonEvents(result.stdout)
        expect(events.map((event) => event.type)).toEqual([
          "step_start",
          "reasoning",
          "tool_use",
          "text",
          "tool_result",
          "step_finish",
          "step_start",
          "text",
          "step_finish",
        ])
        expect(events.find((event) => event.type === "reasoning")?.event).toEqual(
          expect.objectContaining({
            type: "session.next.reasoning.ended",
            properties: expect.objectContaining({ text: "reasoning" }),
          }),
        )
        expect(events.find((event) => event.type === "tool_use")?.event).toEqual(
          expect.objectContaining({
            type: "session.next.tool.called",
            properties: expect.objectContaining({ tool: "bash" }),
          }),
        )
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.startsWith("{")),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json records partial output for an unknown stream finish",
    ({ llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial json").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.fail("provider failed")
        const result = yield* zaovra.run("fail after output", { format: "json" })

        const events = zaovra.parseJsonEvents(result.stdout)
        expect(result.exitCode).not.toBe(0)
        expect(events.map((event) => event.type)).toEqual([
          "step_start",
          "tool_use",
          "text",
          "tool_result",
          "step_finish",
          "step_start",
          "error",
        ])
        expect(events.find((event) => event.type === "text")?.event).toEqual(
          expect.objectContaining({
            type: "session.next.text.ended",
            properties: expect.objectContaining({ text: "partial json" }),
          }),
        )
        expect(events.at(-1)?.error).toEqual(expect.objectContaining({ message: expect.any(String) }))
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects requested permissions by default and allows them with the dangerous flag",
    ({ home, llm, zaovra }) =>
      Effect.gen(function* () {
        yield* llm.tool("bash", { command: "rm -f denied-file", description: "Remove a test file" })
        yield* llm.text("continued after rejection")
        const denied = yield* zaovra.run("request permission", { permission: { bash: "ask" } })
        zaovra.expectExit(denied, 0)
        expect(denied.stderr).toContain("permission requested: bash")
        expect(denied.stdout).toBe("")

        yield* llm.reset
        yield* llm.tool("bash", { command: "rm -f allowed-file", description: "Remove a test file" })
        yield* llm.text("continued after approval")
        const allowed = yield* zaovra.run("request permission", {
          permission: { bash: "ask" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        zaovra.expectExit(allowed, 0)
        expect(allowed.stderr).not.toContain("permission requested: bash")
        expect(allowed.stdout).toContain("continued after approval")

        yield* llm.reset
        yield* llm.tool("bash", { command: "touch explicitly-denied", description: "Create a denied marker" })
        yield* llm.text("continued after explicit denial")
        const explicitlyDenied = yield* zaovra.run("request denied permission", {
          permission: { bash: "deny" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        zaovra.expectExit(explicitlyDenied, 0)
        expect(explicitlyDenied.stdout).toContain("continued after explicit denial")
        expect(yield* Effect.promise(() => Bun.file(`${home}/explicitly-denied`).exists())).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "attach mode sends client-local file contents without a shared path",
    ({ home, llm, zaovra }) =>
      Effect.gen(function* () {
        const source = `${home}/client-only.txt`
        const sentinel = "client-only attachment sentinel"
        yield* Effect.promise(() => Bun.write(source, sentinel))
        yield* llm.text("attachment received")
        const server = yield* zaovra.serve()

        const result = yield* zaovra.run("read the attachment", {
          extraArgs: ["--attach", server.url, `--file=${source}`, "--"],
        })

        zaovra.expectExit(result, 0)
        const input = JSON.stringify(yield* llm.inputs)
        expect(input).toContain(sentinel)
        expect(input).not.toContain(`file://${source}`)
      }),
    60_000,
  )

  cliIt.concurrent(
    "attach mode rejects local directories before prompt admission",
    ({ home, zaovra }) =>
      Effect.gen(function* () {
        const result = yield* zaovra.run("read the directory", {
          extraArgs: ["--attach", "http://127.0.0.1:1", `--file=${home}`, "--"],
        })

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Cannot attach local directory without a shared filesystem")
      }),
    30_000,
  )

  if (process.platform === "win32") {
    test.skip("SIGINT interrupts an active non-interactive run without leaking the process", () => {})
  } else {
    cliIt.live(
      "SIGINT interrupts an active non-interactive run without leaking the process",
      ({ llm, zaovra }) =>
        Effect.gen(function* () {
          yield* llm.hang
          const run = yield* zaovra.startRun("wait forever")
          yield* llm.wait(1)
          run.interrupt()
          const result = yield* run.result

          expect(result.exitCode).not.toBe(0)
          expect(result.durationMs).toBeLessThan(30_000)
        }),
      30_000,
    )
  }
})
