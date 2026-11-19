import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { runBillingChain } from "../../../../script/evaluation/memory/pilot"
import { startEvaluationRelay } from "../../../../script/evaluation/memory/relay"
import { chains } from "../../../../script/evaluation/memory/cases"
import { tmpdir } from "../fixture/fixture"

// The pilot deliberately rejects a dirty source tree. Commit the candidate before running this test.
test.skipIf(process.platform !== "win32")(
  "billing pilot preserves all five real Sessions in both A and B",
  async () => {
    await using tmp = await tmpdir()
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim()
    const chain = chains.find((entry) => entry.id === "billing")!
    for (const treatment of ["A", "B"] as const) {
      const rounds = [0, 0, 0, 0, 0]
      const requests: Array<{ stage: number; body: string }> = []
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as { messages: Array<{ role: string; content: unknown }> }
          const users = JSON.stringify(body.messages.filter((message) => message.role === "user"))
          const index = chain.prompts.findIndex((prompt) => users.includes(prompt))
          if (index < 0 || ++rounds[index]! > 3)
            return Response.json({ error: { message: "unexpected fixture request" } }, { status: 400 })
          requests.push({ stage: index + 1, body: JSON.stringify(body) })
          const artifacts =
            index === 0
              ? { "config.json": { timeout: 45, retries: 2 } }
              : index === 2
                ? { "secondary.json": { timeout: 45, retries: 2 } }
                : index === 3
                  ? { "config.json": { timeout: 20, retries: 0 }, "secondary.json": { timeout: 20, retries: 0 } }
                  : { "history.json": chain.history }
          const python = [
            "import json,pathlib",
            ...Object.entries(artifacts).map(
              ([name, value]) =>
                `pathlib.Path(${JSON.stringify(name)}).write_text(${JSON.stringify(JSON.stringify(value))}, encoding='utf-8')`,
            ),
          ].join("\n")
          const call =
            index === 1 || rounds[index] === 3
              ? undefined
              : rounds[index] === 1
                ? { name: "tool_search", arguments: { names: ["bash"] } }
                : {
                    name: "bash",
                    arguments: {
                      command: `python -c "import base64;exec(base64.b64decode('${Buffer.from(python).toString("base64")}'))"`,
                      description: "Write the fixed fixture artifacts",
                      timeout: 5000,
                      hard_timeout_ms: 8000,
                    },
                  }
          const chunk = (choices: unknown[], usage?: object) =>
            `data: ${JSON.stringify({ id: `billing-${index}-${rounds[index]}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices, usage })}\n\n`
          return new Response(
            chunk([
              {
                index: 0,
                delta: call
                  ? {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: `call-${index}-${rounds[index]}`,
                          type: "function",
                          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                        },
                      ],
                    }
                  : { role: "assistant", content: "Done." },
                finish_reason: null,
              },
            ]) +
              chunk([{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }]) +
              chunk([], { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }) +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      const journal = path.join(tmp.path, treatment + "-relay.jsonl")
      const relay = startEvaluationRelay({
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
        apiKey: "private-upstream-fixture-key",
        model: "fixture-model",
        protocol: "openai-chat",
        journal,
        maxRequests: 13,
        maxRequestBytes: 131072,
        maxOutput: 4096,
      })
      try {
        const root = path.join(tmp.path, treatment)
        const result = await runBillingChain({
          root,
          candidate,
          family: "deepseek",
          modelID: "fixture-model",
          treatment,
          baseURL: relay.baseURL,
          reserveTokens: 1,
          relayKey: relay.apiKey,
          ...(treatment === "B" ? { relay } : {}),
        })
        if (!result.pass) {
          const last = JSON.parse(requests.at(-1)!.body) as { messages: Array<{ role: string; content: unknown }> }
          console.error({ treatment, stages: result.stages, rounds, tools: last.messages.filter((message) => message.role === "tool") })
        }
        expect(result.pass).toBe(true)
        expect(result.counts).toEqual({ planned: 5, entered: 5, completed: 5, notRun: 0 })
        expect(rounds).toEqual([3, 1, 3, 3, 3])
        expect(result.usage).toEqual({ status: "unknown", total: null, reserve: "retain" })
        const sessions: string[] = []
        for (let stage = 1; stage <= 5; stage++) {
          const session = await Bun.file(path.join(root, `stage-${stage}`, "session.json")).json()
          expect(session.stopped).toMatchObject({ remaining: [], controllerExit: 0 })
          sessions.push(session.admission.sessionID)
          const grade = await Bun.file(path.join(root, `stage-${stage}`, "grade.json")).json()
          expect(
            grade.artifacts.every((entry: { artifact?: { sha256: string } }) =>
              /^[a-f0-9]{64}$/.test(entry.artifact?.sha256 ?? ""),
            ),
          ).toBe(true)
        }
        expect(new Set(sessions).size).toBe(5)
        if (treatment === "B") {
          expect(result.stageUsage?.stages.map((stage) => stage.sessionID)).toEqual(sessions)
          expect(result.stageUsage?.stages.map((stage) => stage.physicalRequests)).toEqual(rounds)
          expect(result.stageUsage?.fullChain).toMatchObject({
            status: "reported",
            reportedRequests: 13,
            observed: { input: 260, output: 65, total: 325 },
            eligibleForCostComparison: true,
          })
          expect(result.stageUsage?.laterStages).toMatchObject({
            reportedRequests: 10,
            observed: { input: 200, output: 50, total: 250 },
            eligibleForCostComparison: true,
          })
        }
        if (treatment === "A") expect(result.stageUsage).toBeUndefined()
        for (const entry of requests) {
          const body = JSON.parse(entry.body) as { tools?: Array<{ function: { name: string } }> }
          const names = (body.tools ?? []).map((tool) => tool.function.name)
          expect(names.filter((name) => name.startsWith("memory_"))).toEqual([])
        }
        const fourth = requests.find((entry) => entry.stage === 4)!.body
        expect(fourth.includes(chain.poisonedNote)).toBe(treatment === "B")
        expect(fourth).not.toContain("artificial-poison")
        expect(fourth).not.toContain("intentionally false")
        const fixture = await Bun.file(path.join(root, "stage-4", "fixture.json")).json()
        expect(fixture.sourceSessionID).toBe(sessions[2])
        expect(fixture.fixture).toBe("artificial-poison")
        const records = (await Bun.file(journal).text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(records.filter((record) => record.phase === "admitted")).toHaveLength(13)
        expect(records.filter((record) => record.phase === "eof")).toHaveLength(13)
        expect(await Bun.file(path.join(root, "profile", "config", "zaovra", "zaovra.json")).text()).not.toContain(
          "private-upstream-fixture-key",
        )
      } finally {
        await relay.stop()
        await provider.stop(true)
      }
    }
  },
  240000,
)

test.skipIf(process.platform !== "win32")(
  "billing pilot separates a failed Session from four unrun stages",
  async () => {
    await using tmp = await tmpdir()
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim()
    let calls = 0
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++
        return Response.json(
          { error: { message: "private-upstream-failure", type: "invalid_request_error" } },
          { status: 400 },
        )
      },
    })
    try {
      const root = path.join(tmp.path, "failure")
      const result = await runBillingChain({
        root,
        candidate,
        family: "deepseek",
        modelID: "fixture-model",
        treatment: "A",
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
        reserveTokens: 1,
        relayKey: randomUUID(),
      })
      expect(result.pass).toBe(false)
      expect(result.counts).toEqual({ planned: 5, entered: 1, completed: 0, notRun: 4 })
      expect(result.stages[0]).toMatchObject({
        status: "failed",
        phase: "session",
        category: "product-turn",
        reason: "evaluation-session-not-completed",
      })
      expect(result.stages.slice(1).every((stage) => stage.status === "not-run")).toBe(true)
      expect(JSON.stringify(result)).not.toContain("private-upstream-failure")
      expect(await Bun.file(path.join(root, "stage-1", "grade.json")).exists()).toBe(false)
      expect(await Bun.file(path.join(root, "stage-2", "session.json")).exists()).toBe(false)
      expect(calls).toBe(1)
    } finally {
      await provider.stop(true)
    }
  },
  30000,
)
