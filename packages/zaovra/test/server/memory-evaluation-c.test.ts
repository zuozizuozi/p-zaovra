import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { runEvaluationChain } from "../../../../script/evaluation/memory/pilot"
import { startEvaluationRelay } from "../../../../script/evaluation/memory/relay"
import { chains } from "../../../../script/evaluation/memory/cases"
import { tmpdir } from "../fixture/fixture"

// The real driver checks clean committed source on every stage; commit before running.
test.skipIf(process.platform !== "win32")(
  "C keeps one host grant across five restarted Sessions and rejects changed model capability",
  async () => {
    await using tmp = await tmpdir()
    const chain = chains.find((item) => item.id === "format")!
    const rounds = [0, 0, 0, 0, 0]
    const calls: Array<{ stage: number; names: string[] }> = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          messages: Array<{ role: string; content: unknown }>
          tools?: Array<{ function: { name: string } }>
        }
        const users = JSON.stringify(body.messages.filter((message) => message.role === "user"))
        const stage = chain.prompts.findIndex((prompt) => users.includes(prompt))
        if (stage < 0 || ++rounds[stage]! > 3) return new Response(null, { status: 400 })
        calls.push({ stage: stage + 1, names: (body.tools ?? []).map((tool) => tool.function.name) })
        const call =
          rounds[stage] === 1
            ? { name: "tool_search", arguments: { names: ["memory_note"] } }
            : rounds[stage] === 2
              ? {
                  name: "memory_note",
                  arguments: { kind: "decision", text: `C host note stage ${stage + 1}`, basis: "fixed local fixture" },
                }
              : undefined
        const chunk = (choices: unknown[]) =>
          `data: ${JSON.stringify({ id: `c-${stage}-${rounds[stage]}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices })}\n\n`
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
                        id: `c-call-${rounds[stage]}`,
                        type: "function",
                        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                      },
                    ],
                  }
                : { role: "assistant", content: "Fixture completed." },
              finish_reason: null,
            },
          ]) +
            chunk([{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }]) +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const relay = startEvaluationRelay({
      baseURL: `http://127.0.0.1:${provider.port}/v1`,
      apiKey: "fixture-only",
      model: "fixture-model",
      protocol: "openai-chat",
      journal: path.join(tmp.path, "relay.jsonl"),
      maxRequests: 18,
      maxRequestBytes: 131072,
      maxOutput: 4096,
    })
    try {
      const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim()
      const root = path.join(tmp.path, "c-chain")
      const sessions: string[] = []
      const base = {
        candidate,
        family: "deepseek" as const,
        modelID: "fixture-model",
        treatment: "C" as const,
        chainID: "format",
        reserveTokens: 1,
        baseURL: relay.baseURL,
        relayKey: relay.apiKey,
        relay,
        capture: { maxBytes: 65536, maxParts: 64 },
      }
      const result = await runEvaluationChain({
        ...base,
        root,
        grade: async ({ stage, session, directory }) => {
          expect(session.stopped.remaining).toEqual([])
          expect(session.observation.turnEvidence?.status).toBe("complete")
          expect(await Bun.file(path.join(directory, "notes.txt")).text()).toBe(
            stage < 4 ? chain.seed["notes.txt"]! : chain.beforeFourth.write["notes.txt"]!,
          )
          sessions.push(session.admission.sessionID)
          return { pass: false, reason: "fixture-not-real-capability" }
        },
      })
      expect(
        result.counts,
        JSON.stringify(result) +
          "\n" +
          (await Bun.file(path.join(root, "stage-1", "backend.log"))
            .text()
            .catch(() => "no backend log")),
      ).toEqual({ planned: 5, entered: 5, completed: 5, notRun: 0 })
      expect(new Set(sessions).size).toBe(5)
      expect(result.stageUsage?.stages.map((stage) => stage.sessionID)).toEqual(sessions)
      expect(result.stageUsage?.stages.map((stage) => stage.unknownRequests)).toEqual([3, 3, 3, 3, 3])
      expect(result.stageUsage?.fullChain).toMatchObject({ status: "unknown", eligibleForCostComparison: false })
      expect(calls).toHaveLength(15)
      expect(calls.filter((_, index) => index % 3 === 1).every((call) => call.names.includes("memory_note"))).toBe(true)
      const generations = []
      for (let stage = 1; stage <= 5; stage++)
        generations.push((await Bun.file(path.join(root, `stage-${stage}`, "ready.json")).json()).generation)
      expect(new Set(generations).size).toBe(5)
      const fixture = await Bun.file(path.join(root, "stage-4", "fixture.json")).json()
      expect(fixture.sourceSessionID).toBe(sessions[2])
      const db = new Database(path.join(root, "profile", "sessions.sqlite"), { readonly: true })
      try {
        const notes = db
          .query(
            "select text,status,origin,session_id,seq from memory_note where text like 'C host note stage %' order by text",
          )
          .all()
        expect(notes).toHaveLength(5)
        for (const [index, note] of notes.entries())
          expect(note).toMatchObject({ status: "unverified", origin: "model", session_id: sessions[index] })
      } finally {
        db.close()
      }
      const manifest = await Bun.file(path.join(root, "manifest.json")).json()
      expect(manifest).toMatchObject({
        treatment: "C",
        memory: { enabled: true, modelTools: true, taskSearch: true, index: { enabled: true } },
        taskSearch: true,
        memoryNoteProfile: "experimental-host-bound",
        tidy: false,
      })
      // An owning handle is required; the same URL/key/hash in a lookalike object is insufficient.
      await expect(
        runEvaluationChain({
          ...base,
          root: path.join(tmp.path, "fake"),
          relay: { ...relay },
          grade: async () => ({ pass: true, reason: "unused" }),
        }),
      ).rejects.toThrow("evaluation-relay-not-owned")
      rounds.fill(0)
      const mismatchRoot = path.join(tmp.path, "changed-chain")
      const changed = await runEvaluationChain({
        ...base,
        root: mismatchRoot,
        grade: async ({ stage }) => {
          if (stage === 1)
            await Bun.write(
              path.join(mismatchRoot, "workspace", "zaovra.json"),
              JSON.stringify({
                provider: { "evaluation-deepseek": { models: { "fixture-model": { tool_call: false } } } },
              }),
            )
          return { pass: false, reason: "fixture-mutated-capability" }
        },
      })
      expect(changed.counts).toEqual({ planned: 5, entered: 2, completed: 1, notRun: 3 })
      expect(changed.stageUsage?.runID).not.toBe(result.stageUsage?.runID)
      expect(changed.stageUsage?.stages.map((stage) => stage.status)).toEqual([
        "unknown",
        "no-requests",
        "not-run",
        "not-run",
        "not-run",
      ])
      expect(changed.stageUsage?.fullChain.eligibleForCostComparison).toBe(false)
      expect(changed.stages[1]).toMatchObject({ status: "failed", reason: "evaluation-backend-ended-before-ready" })
      expect(calls).toHaveLength(18)
      expect(await Bun.file(path.join(mismatchRoot, "stage-2", "incomplete.json")).exists()).toBe(true)
    } finally {
      await relay.stop()
      await provider.stop(true)
    }
  },
  120000,
)
