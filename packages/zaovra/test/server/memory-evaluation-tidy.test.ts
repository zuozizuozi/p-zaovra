import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { runEvaluationChain } from "../../../../script/evaluation/memory/pilot"
import { evaluationTidyRelay, startEvaluationRelay } from "../../../../script/evaluation/memory/relay"
import { tmpdir } from "../fixture/fixture"

const model = "fixture-model"
const numeric = { input_tokens: 20, output_tokens: 5, total_tokens: 25 }
const finish = {
  type: "response.completed",
  response: { status: "completed", id: "resp_fixture", model, usage: numeric },
}
const text = { type: "response.output_text.delta", item_id: "msg_fixture", delta: "Fixed local fixture complete." }
const sse = (...frames: unknown[]) =>
  new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })

test("dedicated count relay binds one positive exact-wire permit with its own physical ceiling", async () => {
  await using tmp = await tmpdir()
  const hits: string[] = []
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const route = new URL(request.url).pathname
      hits.push(route)
      return route.endsWith("/input_tokens")
        ? Response.json({ object: "response.input_tokens", input_tokens: 20 })
        : sse(text, finish)
    },
  })
  const relay = startEvaluationRelay({
    baseURL: `http://127.0.0.1:${provider.port}/v1`,
    apiKey: "test-provider",
    model,
    protocol: "openai-responses",
    journal: path.join(tmp.path, "relay.jsonl"),
    maxCountRequests: 1,
    maxRequests: 2,
    maxOutput: 100,
    maxRequestBytes: 4096,
  })
  const send = (suffix: string, body: object, apiKey: string = relay.apiKey) =>
    fetch(relay.baseURL + "/responses" + suffix, {
      method: "POST",
      headers: { authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
    })
  const input = { model, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "test" }] }] }
  const generation = { ...input, stream: true, max_output_tokens: 25 }
  try {
    expect((await send("/input_tokens", input)).status).toBe(403)
    const tidy = evaluationTidyRelay(relay)
    {
      using grant = tidy.open({ taskID: "fixture", sessionID: "ses_fixture" })
      expect((await send("/input_tokens", input, "wrong")).status).toBe(403)
      expect((await send("/input_tokens?next=1", input)).status).toBe(403)
      expect((await send("/input_tokens", { ...input, stream: true })).status).toBe(400)
      expect((await send("", generation)).status).toBe(403)
      expect(await (await send("/input_tokens", input)).json()).toEqual({
        object: "response.input_tokens",
        input_tokens: 20,
      })
      expect((await send("/input_tokens", input)).status).toBe(429)
      expect((await send("", { ...generation, instructions: "different" })).status).toBe(403)
      expect(await (await send("", generation)).text()).toContain("response.completed")
      expect((await send("", generation)).status).toBe(403)
    }
    expect((await send("/input_tokens", input)).status).toBe(403)
    expect(hits).toEqual(["/v1/responses/input_tokens", "/v1/responses"])
    expect(tidy.evidence().generationIDs).toHaveLength(1)
  } finally {
    await relay.stop()
    await provider.stop(true)
  }
})

for (const scenario of ["http-404", "valid-count"] as const) {
  test.skipIf(process.platform !== "win32")(
    `D product tidy between poison and user admission: ${scenario}`,
    async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, scenario)
      const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim()
      const calls: string[] = []
      let tidyTurns = 0
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const route = new URL(request.url).pathname
          const body = (await request.json()) as { input: unknown }
          if (route === "/v1/responses/input_tokens") {
            calls.push("tidy-count")
            return scenario === "http-404"
              ? new Response(null, { status: 404 })
              : Response.json({ object: "response.input_tokens", input_tokens: 20 })
          }
          const tidy = JSON.stringify(body.input).includes("整理当前项目记忆")
          calls.push(tidy ? "tidy-generation" : "user-generation")
          if (!tidy || ++tidyTurns > 1) return sse(text, finish)
          const fixture = await Bun.file(path.join(root, "stage-4", "fixture.json")).json()
          const item = { type: "function_call", id: "fc_tidy", call_id: "call_tidy", name: "memory_review" }
          const args = JSON.stringify({
            layer: "project",
            decisions: [
              { id: fixture.inserted, action: "stale", basis: "The local publish fixture uses the renamed script." },
            ],
          })
          return sse(
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, arguments: "", status: "in_progress" },
            },
            { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: args },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: { ...item, arguments: args, status: "completed" },
            },
            finish,
          )
        },
      })
      const relayOptions = {
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
        apiKey: "fixed-synthetic-only",
        model,
        protocol: "openai-responses" as const,
        maxRequests: 20,
        maxOutput: 4096,
        maxRequestBytes: 131072,
      }
      const relay = startEvaluationRelay({ ...relayOptions, journal: path.join(tmp.path, "ordinary.jsonl") })
      const tidy = startEvaluationRelay({
        ...relayOptions,
        maxRequests: 8,
        maxCountRequests: 8,
        journal: path.join(tmp.path, "tidy.jsonl"),
      })
      try {
        const result = await runEvaluationChain({
          root,
          candidate,
          family: "gpt",
          modelID: model,
          treatment: "D",
          chainID: "publish",
          relay,
          baseURL: relay.baseURL,
          relayKey: relay.apiKey,
          reserveTokens: 1,
          tidy: { relay: tidy, tokens: 20000, dailyTokens: 20000 },
          grade: async () => ({ pass: false, reason: "transport-fixture-only" }),
        })
        const file = Bun.file(path.join(root, "stage-4", "tidy.json"))
        const evidence = await file.json().catch(() => undefined)
        const logs = await Promise.all([
          Bun.file(path.join(tmp.path, "tidy.jsonl")).text(),
          Bun.file(path.join(tmp.path, "ordinary.jsonl")).text(),
        ])
        using db = new Database(path.join(root, "profile", "sessions.sqlite"), { readonly: true })
        const terminalRows = evidence?.terminal?.sessionID
          ? db
              .query<{ seq: number; data: string }, [string]>(
                "select seq, data from session_message where session_id = ? and type = 'assistant' order by seq",
              )
              .all(evidence.terminal.sessionID)
              .map(({ seq, data }) => {
                const message = JSON.parse(data)
                return { seq, error: message.error, finish: message.finish }
              })
          : []
        if (process.env.ZAOVRA_TEST_REPORT_DIR)
          await Bun.write(
            path.join(process.env.ZAOVRA_TEST_REPORT_DIR, `d-${scenario}.json`),
            JSON.stringify(
              {
                result,
                evidence,
                calls,
                terminalRows,
                failureLines:
                  evidence?.status === "rejected"
                    ? (await Bun.file(path.join(root, "stage-4", "backend.log")).text())
                        .split(/\r?\n/)
                        .filter((line) => /Failed to drain Session|TypeError:|Error:|ReferenceError:/.test(line))
                        .map((line) => line.replace(/Bearer\s+[\w-]+/gi, "Bearer [redacted]"))
                        .slice(-20)
                    : [],
                tidyRelay: logs[0],
                ordinaryRelay: logs[1],
                stoppedOnFailure: await Bun.file(path.join(root, "stage-4", "tidy-stopped.json"))
                  .json()
                  .catch(() => undefined),
              },
              null,
              2,
            ),
          )
        expect(evidence, JSON.stringify(result.stages)).toBeDefined()
        expect(evidence.beforeUserAdmission).toBe(true)
        expect(evidence.before.notes.some((note: { id: string }) => note.id === evidence.poisonID)).toBe(true)
        expect(evidence.before.userEvidence.length).toBeGreaterThan(0)
        if (scenario === "http-404") {
          expect(evidence).toMatchObject({
            status: "rejected",
            reason: "evaluation-tidy-input-count-404",
            terminal: { state: "failed", executing: false, usage: { known: 0, reserved: 0, charged: 0, unknown: 0 } },
          })
          expect(evidence.transport.counts).toMatchObject([{ status: 404, inputTokens: null }])
          expect(evidence.transport.generationIDs).toEqual([])
          expect(evidence.after).toEqual(evidence.before)
          expect(result.stageUsage?.stages[3]?.sessionID).toBeNull()
          expect(result.stages[4]?.status).toBe("not-run")
          expect(await Bun.file(path.join(root, "stage-4", "tidy-stopped.json")).json()).toMatchObject({
            stopped: { remaining: [] },
          })
        } else {
          expect(evidence).toMatchObject({
            status: "completed",
            terminal: { state: "completed", executing: false, usage: { known: 50 } },
          })
          expect(evidence.transport.counts.map((row: { inputTokens: number }) => row.inputTokens)).toEqual([20, 20])
          expect(evidence.transport.generationIDs).toHaveLength(2)
          expect(evidence.after.notes.find((note: { id: string }) => note.id === evidence.poisonID).status).toBe(
            "stale",
          )
          expect(evidence.after.userEvidence).toEqual(evidence.before.userEvidence)
          expect(result.stageUsage?.stages[3]?.sessionID).not.toBe(evidence.terminal.sessionID)
          const stage = await Bun.file(path.join(root, "stage-4", "session.json")).json()
          expect(stage.stopped.remaining).toEqual([])
          expect(result.counts.completed).toBe(5)
          expect(calls.slice(calls.indexOf("tidy-count"), calls.indexOf("tidy-count") + 5)).toEqual([
            "tidy-count",
            "tidy-generation",
            "tidy-count",
            "tidy-generation",
            "user-generation",
          ])
        }
      } finally {
        await tidy.stop()
        await relay.stop()
        await provider.stop(true)
      }
    },
    180000,
  )
}
