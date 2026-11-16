import { expect, test } from "bun:test"
import path from "node:path"
import { prepare } from "../../../../script/evaluation/memory/cases"
import { runEvaluationSession } from "../../../../script/evaluation/memory/session"
import { hostVerdict } from "../../../../script/evaluation/memory/host-verdict"
import { tmpdir } from "../fixture/fixture"

for (const command of ["npm test", "npm run test"])
  test.skipIf(process.platform !== "win32")(
    `stage1 bound original alias uses actual host tools: ${command}`,
    async () => {
      await using tmp = await tmpdir()
      const directory = path.join(tmp.path, "workspace")
      const profile = path.join(tmp.path, "profile")
      const fixture = await prepare(directory, "arithmetic")
      await Bun.write(path.join(profile, ".evaluation-profile"), "zaovra-memory-evaluation-v1\n")
      let requests = 0
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          await request.json()
          requests++
          if (requests > 3) return Response.json({ error: { message: "fixture limit" } }, { status: 400 })
          const calls =
            requests === 1
              ? [{ id: "discover", name: "tool_search", arguments: { names: ["bash", "read", "glob", "grep"] } }]
              : requests === 2
                ? [
                    { id: "glob", name: "glob", arguments: { pattern: "**/*", path: "" } },
                    { id: "grep", name: "grep", arguments: { pattern: "exports", path: "" } },
                    ...["package.json", "src/sum.cjs", "test/sum.test.cjs"].map((name, index) => ({
                      id: `read-${index}`,
                      name: "read",
                      arguments: { path: name },
                    })),
                    {
                      id: "test",
                      name: "bash",
                      arguments: {
                        command,
                        workdir: ".",
                        description: "Run original local fixture tests",
                        timeout: 10000,
                        verification: "test",
                        verification_targets: ["package.json", "src/sum.cjs", "test/sum.test.cjs"],
                        verification_assertions: ["test/sum.test.cjs"],
                        verification_requirements: ["Run existing tests."],
                      },
                    },
                  ]
                : []
          const chunk = (choices: unknown[], usage?: object) =>
            `data: ${JSON.stringify({ id: `npm-${requests}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices, usage })}\n\n`
          return new Response(
            chunk([
              {
                index: 0,
                delta: calls.length
                  ? {
                      role: "assistant",
                      tool_calls: calls.map((call, index) => ({
                        index,
                        id: call.id,
                        type: "function",
                        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                      })),
                    }
                  : { role: "assistant", content: "Local fixture finished." },
                finish_reason: null,
              },
            ]) +
              chunk([{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }]) +
              chunk([], { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }) +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      await Bun.write(
        path.join(directory, "zaovra.json"),
        JSON.stringify({
          model: "npm-fixture/fixture",
          shell: "powershell",
          memory: { enabled: false },
          permission: { "*": "allow" },
          formatter: false,
          lsp: false,
          provider: {
            "npm-fixture": {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
              models: { fixture: { limit: { context: 32000, output: 1024 } } },
            },
          },
        }),
      )
      try {
        const session = await runEvaluationSession({
          directory,
          profile,
          stage: path.join(tmp.path, "stage"),
          model: { id: "fixture", providerID: "npm-fixture" },
          prompt: "Inspect local fixture and run existing tests.",
          seconds: 60,
          capture: { maxBytes: 262144, maxParts: 1000 },
        })
        const report = hostVerdict({
          candidate: "a".repeat(40),
          chain: "arithmetic",
          stage: 1,
          directory,
          profile,
          session,
          requirements: ["existing-node-tests-executed-successfully", "no-dependency-install"],
          initialArtifacts: fixture.seed,
          artifacts: Object.fromEntries(
            await Promise.all(
              Object.keys(fixture.seed).map(async (name) => [name, await Bun.file(path.join(directory, name)).text()]),
            ),
          ),
          shell: "powershell",
        })
        if (process.env.ZAOVRA_TEST_REPORT_DIR)
          await Bun.write(
            path.join(process.env.ZAOVRA_TEST_REPORT_DIR, `${command.replaceAll(" ", "-")}.json`),
            JSON.stringify({ report, session, requests }, null, 2),
          )
        expect(session.stopped).toMatchObject({ remaining: [], controllerExit: 0 })
        expect(session.observation.turnEvidence?.status).toBe("complete")
        expect(report.checks[0]).toMatchObject({ status: "verified", reason: "successful-bound-original-npm-script" })
        expect(report.checks[1]).toMatchObject({ status: "unknown", reason: "needs-bound-human-rubric" })
        expect(report.codeReview?.executions[0]!.files).toEqual(
          Object.fromEntries(
            ["src/sum.cjs", "test/sum.test.cjs", "package.json"].map((name) => [name, fixture.seed[name]]),
          ),
        )
        expect(requests).toBe(3)
      } finally {
        await provider.stop(true)
      }
    },
    120000,
  )
