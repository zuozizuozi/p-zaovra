import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { runEvaluationChain } from "../../../../script/evaluation/memory/pilot"
import { startEvaluationRelay } from "../../../../script/evaluation/memory/relay"
import { chains } from "../../../../script/evaluation/memory/cases"
import { tmpdir } from "../fixture/fixture"

// Source must be committed: the real driver refuses mixed-version five-Session chains.
test.skipIf(process.platform !== "win32")(
  "nonbilling chain grades every stopped own Session and retains unknown verdicts",
  async () => {
    await using tmp = await tmpdir()
    const chain = chains.find((item) => item.id === "format")!
    const visited: number[] = []
    const sessions: string[] = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { messages: Array<{ role: string; content: unknown }> }
        const users = JSON.stringify(body.messages.filter((message) => message.role === "user"))
        const index = chain.prompts.findIndex((prompt) => users.includes(prompt))
        if (index < 0) return Response.json({ error: { message: "wrong-frozen-chain" } }, { status: 400 })
        visited.push(index + 1)
        const chunk = (choices: unknown[]) =>
          `data: ${JSON.stringify({ id: `format-${index}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices })}\n\n`
        return new Response(
          chunk([
            {
              index: 0,
              delta: { role: "assistant", content: "A reply is not proof of reading notes." },
              finish_reason: null,
            },
          ]) +
            chunk([{ index: 0, delta: {}, finish_reason: "stop" }]) +
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
      maxRequests: 5,
      maxRequestBytes: 131072,
      maxOutput: 4096,
    })
    try {
      const root = path.join(tmp.path, "format-chain")
      const result = await runEvaluationChain({
        root,
        candidate: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(),
        family: "deepseek",
        modelID: "fixture-model",
        treatment: "A",
        chainID: "format",
        reserveTokens: 1,
        baseURL: relay.baseURL,
        relayKey: relay.apiKey,
        capture: { maxBytes: 65536, maxParts: 32 },
        grade: async ({ directory, stage, session }) => {
          expect(directory).toBe(path.join(root, "workspace"))
          expect(session.stopped).toMatchObject({ remaining: [], controllerExit: 0 })
          expect(session.observation.artifactReady).toBe(true)
          expect(await Bun.file(path.join(directory, "notes.txt")).text()).toBe(
            stage < 4 ? chain.seed["notes.txt"]! : chain.beforeFourth.write["notes.txt"]!,
          )
          expect(session.diagnostics.coverage.status).toBe("complete-through-cut")
          const evidence = session.observation.turnEvidence
          expect(evidence?.status).toBe("complete")
          if (evidence?.status !== "complete") throw new Error("missing-capture")
          expect(evidence.tools).toEqual([])
          expect(evidence.answer).toMatchObject({ status: "selected", text: "A reply is not proof of reading notes." })
          expect(evidence.admission).toEqual(session.admission)
          expect(evidence.snapshot).toEqual(session.observation.evidence.at(-1)!)
          sessions.push(session.admission.sessionID)
          return { pass: false, reason: "needs-host-tool-evidence", inspectedStage: stage }
        },
      })
      expect(result.chain).toBe("format")
      expect(result.counts).toEqual({ planned: 5, entered: 5, completed: 5, notRun: 0 })
      expect(result.pass).toBe(false)
      expect(
        result.stages.every(
          (stage) => stage.status === "completed" && !stage.pass && stage.reason === "needs-host-tool-evidence",
        ),
      ).toBe(true)
      expect(visited).toEqual([1, 2, 3, 4, 5])
      expect(new Set(sessions).size).toBe(5)
      expect(result.usage).toMatchObject({ status: "unknown", total: null, reserve: "retain" })
      for (const stage of visited)
        expect(await Bun.file(path.join(root, `stage-${stage}`, "grade.json")).json()).toMatchObject({
          pass: false,
          inspectedStage: stage,
        })
      const fixture = await Bun.file(path.join(root, "stage-4", "fixture.json")).json()
      expect(fixture.sourceSessionID).toBe(sessions[2])
    } finally {
      await relay.stop()
      await provider.stop(true)
    }
  },
  120000,
)
