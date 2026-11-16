import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, readFile } from "node:fs/promises"
import { prepare, change } from "../../../../script/evaluation/memory/cases"
import { runEvaluationSession } from "../../../../script/evaluation/memory/session"
import { hostVerdict } from "../../../../script/evaluation/memory/host-verdict"
import { tmpdir } from "../fixture/fixture"

test.skipIf(process.platform !== "win32")(
  "host verdict consumes real foreground npm and Read results after an empty Job",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "workspace")
    const profile = path.join(tmp.path, "profile")
    const stage = path.join(tmp.path, "stage")
    await prepare(directory, "arithmetic")
    await change(directory, "arithmetic")
    await mkdir(profile)
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
            ? [{ id: "discover", name: "tool_search", arguments: { names: ["bash", "read"] } }]
            : requests === 2
              ? [
                  { id: "read-package", name: "read", arguments: { path: "package.json" } },
                  { id: "read-tests", name: "read", arguments: { path: "test/math.test.cjs" } },
                  {
                    id: "check",
                    name: "bash",
                    arguments: {
                      command: "npm run check",
                      description: "Run fixture tests",
                      timeout: 10000,
                      hard_timeout_ms: 15000,
                    },
                  },
                ]
              : []
        const chunk = (choices: unknown[], usage?: object) =>
          `data: ${JSON.stringify({ id: `host-${requests}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices, usage })}\n\n`
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
                : { role: "assistant", content: "Local fixture checks finished." },
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
        model: "host-fixture/fixture",
        shell: "powershell",
        memory: { enabled: false },
        permission: { "*": "allow" },
        formatter: false,
        lsp: false,
        provider: {
          "host-fixture": {
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
        stage,
        model: { id: "fixture", providerID: "host-fixture" },
        prompt: "Read both current package.json and test/math.test.cjs, then run npm run check in foreground.",
        seconds: 60,
        capture: { maxBytes: 262144, maxParts: 1000 },
      })
      expect(session.stopped).toMatchObject({ remaining: [], controllerExit: 0 })
      expect(session.observation.turnEvidence?.status).toBe("complete")
      const report = hostVerdict({
        candidate: "a".repeat(40),
        chain: "arithmetic",
        stage: 4,
        directory,
        profile,
        session,
        requirements: ["npm-run-check-succeeded", "read-updated-test-and-package", "no-old-direct-node-command"],
        artifacts: {
          "package.json": await readFile(path.join(directory, "package.json"), "utf8"),
          "test/math.test.cjs": await readFile(path.join(directory, "test/math.test.cjs"), "utf8"),
        },
      })
      if (process.env.ZAOVRA_HOST_VERDICT_REPORT)
        await Bun.write(process.env.ZAOVRA_HOST_VERDICT_REPORT, JSON.stringify({ report, session }, null, 2))
      expect(
        report.checks.map((check) => ({ requirement: check.requirement, status: check.status, reason: check.reason })),
      ).toEqual([
        { requirement: "npm-run-check-succeeded", status: "verified", reason: "successful-host-execution" },
        {
          requirement: "read-updated-test-and-package",
          status: "verified",
          reason: "current-stage-complete-read-content-not-file-identity",
        },
        {
          requirement: "no-old-direct-node-command",
          status: "verified",
          reason: "complete-interpretable-fixture-trace",
        },
      ])
      expect(requests).toBe(3)
    } finally {
      await provider.stop(true)
    }
  },
  120000,
)
