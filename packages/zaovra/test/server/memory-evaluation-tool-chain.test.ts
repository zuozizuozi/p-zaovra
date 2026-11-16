import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { runEvaluationSession } from "../../../../script/evaluation/memory/session"
import { tmpdir } from "../fixture/fixture"

type RequestBody = {
  messages: Array<{ role: string; tool_call_id?: string; content?: unknown }>
  tools?: Array<{ function: { name: string } }>
}

for (const capture of [false, true])
  test.skipIf(process.platform !== "win32")(
    `evaluation executes a bounded process before freezing its artifact (capture=${capture})`,
    async () => {
      await using tmp = await tmpdir()
      const directory = path.join(tmp.path, "workspace")
      const profile = path.join(tmp.path, "profile")
      const stage = path.join(tmp.path, "stage")
      await mkdir(directory)
      await mkdir(profile)
      await Bun.write(path.join(profile, ".evaluation-profile"), "zaovra-memory-evaluation-v1\n")
      const nonce = randomUUID()
      // Only this actual OS child can create the artifact. The upstream never writes it.
      await Bun.write(
        path.join(directory, "tool-worker.py"),
        [
          "import json, os, pathlib, time",
          "time.sleep(0.15)",
          `pathlib.Path('artifact.json').write_text(json.dumps({'nonce': '${nonce}', 'pid': os.getpid(), 'parent': os.getppid()}), encoding='utf-8')`,
          `print('tool-child-finished:${nonce}', flush=True)`,
        ].join("\n"),
      )
      const requests: Array<{ names: string[]; toolResults: Array<{ id?: string; content: string }> }> = []
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as RequestBody
          requests.push({
            names: (body.tools ?? []).map((tool) => tool.function.name),
            toolResults: body.messages
              .filter((message) => message.role === "tool")
              .map((message) => ({ id: message.tool_call_id, content: JSON.stringify(message.content) })),
          })
          const round = requests.length
          if (round > 3)
            return Response.json(
              { error: { message: "fixture request limit", type: "invalid_request_error" } },
              { status: 400 },
            )
          const call =
            round === 1
              ? { id: "discover-process", name: "tool_search", arguments: { names: ["bash"] } }
              : round === 2
                ? {
                    id: "execute-process",
                    name: "bash",
                    arguments: {
                      command: "python tool-worker.py",
                      description: "Run the bounded local fixture worker",
                      timeout: 5000,
                      hard_timeout_ms: 8000,
                    },
                  }
                : undefined
          const chunk = (choices: unknown[], usage?: object) =>
            `data: ${JSON.stringify({ id: `tool-fixture-${round}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices, usage })}\n\n`
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
                          id: call.id,
                          type: "function",
                          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                        },
                      ],
                    }
                  : { role: "assistant", content: `The local worker finished. ${nonce}` },
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
      await Bun.write(
        path.join(directory, "zaovra.json"),
        JSON.stringify({
          model: "tool-fixture/fixture-model",
          shell: "powershell",
          memory: { enabled: false },
          permission: { "*": "allow" },
          formatter: false,
          lsp: false,
          provider: {
            "tool-fixture": {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
              models: { "fixture-model": { limit: { context: 32000, output: 1024 } } },
            },
          },
        }),
      )
      try {
        const result = await runEvaluationSession({
          directory,
          profile,
          stage,
          model: { id: "fixture-model", providerID: "tool-fixture" },
          prompt:
            "Discover bash and run python tool-worker.py once in this directory. It writes artifact.json. Wait for the worker to finish, then report its completion.",
          seconds: 30,
          ...(capture ? { capture: { maxBytes: 65536, maxParts: 32 } } : {}),
        })
        // runEvaluationSession can return only after root-only online checks and an acknowledged empty Job.
        // No artifact read, stat or database inspection happens before these assertions.
        expect(result.stopped).toMatchObject({ remaining: [], controllerExit: 0 })
        expect(result.observation.artifactReady).toBe(true)
        expect(result.observation.turn).toBeDefined()
        expect(result.diagnostics.coverage.status).toBe("complete-through-cut")
        expect(result.diagnostics.billing).toMatchObject({ status: "unknown", total: null, reserve: "retain" })
        expect(requests).toHaveLength(3)
        expect(requests[0].names).toContain("tool_search")
        expect(requests[1].names).toContain("bash")
        expect(requests[1].toolResults.find((entry) => entry.id === "discover-process")?.content).toContain("bash")
        expect(requests[2].toolResults.find((entry) => entry.id === "execute-process")?.content).toContain(
          `tool-child-finished:${nonce}`,
        )
        const artifact = await Bun.file(path.join(directory, "artifact.json")).json()
        expect(artifact.nonce).toBe(nonce)
        expect(Number.isSafeInteger(artifact.pid) && artifact.pid > 0).toBe(true)
        expect(artifact.pid).not.toBe(result.stopped.pid)
        expect(Number.isSafeInteger(artifact.parent) && artifact.parent > 0).toBe(true)
        using db = new Database(path.join(profile, "sessions.sqlite"), { readonly: true })
        const messages = db
          .query("select data from session_message where session_id = ? and type = 'assistant'")
          .all(result.admission.sessionID) as Array<{ data: string }>
        const tools = messages
          .flatMap((row) => JSON.parse(row.data).content ?? [])
          .filter((part) => part.type === "tool")
        expect(tools.map((part) => part.name)).toEqual(["tool_search", "bash"])
        expect(tools.every((part) => part.state.status === "completed" && part.time.completed !== undefined)).toBe(true)
        if (!capture) {
          expect(result.observation.turnEvidence).toBeUndefined()
          expect(JSON.stringify(result)).not.toContain(nonce)
        }
        if (capture) {
          const evidence = result.observation.turnEvidence
          expect(evidence?.status).toBe("complete")
          if (evidence?.status !== "complete") throw new Error("missing-opt-in-evidence")
          expect(evidence.admission).toEqual(result.admission)
          expect(evidence.snapshot).toEqual(result.observation.evidence.at(-1)!)
          expect(evidence.tools.map((tool) => tool.name)).toEqual(["tool_search", "bash"])
          expect(
            evidence.tools.every(
              (tool) =>
                tool.messageID && tool.partID && Number.isInteger(tool.seq) && tool.state.status === "completed",
            ),
          ).toBe(true)
          expect(JSON.stringify(evidence.tools[1].state)).toContain(`tool-child-finished:${nonce}`)
          expect(evidence.answer).toMatchObject({ status: "selected", text: `The local worker finished. ${nonce}` })
          expect(JSON.stringify(evidence.answer)).not.toContain("tool-child-finished:")
        }
        console.log(
          JSON.stringify({
            evidence: "real-tool-chain",
            requests: requests.length,
            tools: tools.map((part) => part.name),
            backendPID: result.stopped.pid,
            childPID: artifact.pid,
            remaining: result.stopped.remaining,
            history: result.diagnostics.coverage.status,
          }),
        )
      } catch (error) {
        for (const name of ["backend.log", "incomplete.json"]) {
          const file = Bun.file(path.join(stage, name))
          if (await file.exists()) console.error((await file.text()).slice(-16000))
        }
        console.error(JSON.stringify({ requests }))
        throw error
      } finally {
        await provider.stop(true)
      }
    },
    65000,
  )
