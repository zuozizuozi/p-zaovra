import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { access } from "node:fs/promises"
import path from "node:path"
import { runEvaluationChain } from "../../../../script/evaluation/memory/pilot"
import { runHostGradedChain } from "../../../../script/evaluation/memory/host-chain"
import { chains } from "../../../../script/evaluation/memory/cases"
import { tmpdir } from "../fixture/fixture"

const briefing =
  "仅在本项目目录内操作，外部目录、外部网络和委派不可用，本轮没有临时确认。遵守工具描述，文件操作优先使用相应文件工具。需要执行命令时，一次提交一个可审查的字面命令并指定本项目workdir；宿主记录退出码，无需追加变量或人工EXIT标记。不得换壳或包装被拒绝的动作来规避权限。若必要动作无法获准，停止并如实说明，不宣称完成。"

test("unknown briefing rejects before endpoint access or directory creation", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "rejected")
  for (const value of ["", "workspace-only-v2", null, {}, false]) {
    await expect(
      runEvaluationChain({
        root,
        candidate: "0".repeat(40),
        family: "deepseek",
        modelID: "fixture-model",
        treatment: "A",
        chainID: "format",
        briefing: value as "workspace-only-v1",
        get baseURL(): string {
          throw new Error("endpoint-accessed-before-validation")
        },
        reserveTokens: 1,
        relayKey: randomUUID(),
        grade: async () => ({ pass: false, reason: "unused" }),
      }),
    ).rejects.toThrow("invalid-evaluation-briefing")
    expect(await Bun.file(path.join(root, "manifest.json")).exists()).toBe(false)
    expect(
      await access(root).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  }
})

// Production pilot requires a committed, clean candidate; the upstream here is local and fixed.
for (const scenario of [
  { chain: "format", briefing: undefined },
  { chain: "format", briefing: "workspace-only-v1" },
  { chain: "build-v2", briefing: "workspace-only-v1" },
] as const)
  test.skipIf(process.platform !== "win32")(
    `host chain ${scenario.chain}/${scenario.briefing ?? "default"} sends five bound prompts`,
    async () => {
      await using tmp = await tmpdir()
      const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim()
      const chain = chains.find((entry) => entry.id === scenario.chain)!
      const original = JSON.stringify(chain.prompts)
      const version = scenario.briefing
      const received: string[] = []
      const rounds = [0, 0, 0, 0, 0]
      const root = path.join(tmp.path, `${chain.id}-${version ?? "default"}`)
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as {
            messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
          }
          const user = body.messages.filter((message) => message.role === "user").at(-1)!
          const text =
            typeof user.content === "string"
              ? user.content
              : user.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("")
          const stage = chain.prompts.findIndex((prompt) => text.includes(prompt))
          if (stage < 0 || ++rounds[stage] > (scenario.chain === "build-v2" && stage === 0 ? 4 : 1))
            return new Response("unexpected extra request", { status: 400 })
          if (rounds[stage] === 1) received[stage] = text
          // Exercise the new literal contract under the unchanged production permission configuration.
          const call =
            scenario.chain !== "build-v2" || stage !== 0 || rounds[stage] === 4
              ? undefined
              : rounds[stage] === 1
                ? { name: "tool_search", arguments: { names: ["bash"] } }
                : {
                    name: "bash",
                    arguments: {
                      command: rounds[stage] === 2 ? "node build.cjs" : "node build.cjs --target web",
                      workdir: path.join(root, "workspace"),
                      description: "Run the fixed build fixture",
                      timeout: 5000,
                      hard_timeout_ms: 8000,
                    },
                  }
          const chunk = (choices: unknown[], usage?: object) =>
            `data: ${JSON.stringify({ id: `briefing-${stage}-${rounds[stage]}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices, usage })}\n\n`
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
                          id: `call-${stage}-${rounds[stage]}`,
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
      try {
        const result = await runHostGradedChain({
          root,
          candidate,
          family: "deepseek",
          modelID: "fixture-model",
          treatment: "A",
          chainID: scenario.chain,
          ...(version ? { briefing: version } : {}),
          baseURL: `http://127.0.0.1:${provider.port}/v1`,
          reserveTokens: 1,
          relayKey: randomUUID(),
        })
        expect(result.counts).toEqual({ planned: 5, entered: 5, completed: 5, notRun: 0 })
        expect(result.chain).toBe(chain.id)
        expect(rounds).toEqual(scenario.chain === "build-v2" ? [4, 1, 1, 1, 1] : [1, 1, 1, 1, 1])
        // A fixed "Done" response proves transport only, never task or memory success.
        expect(result.pass).toBe(false)
        // Provider transport appends a host observation; it is not part of the admitted prompt hash.
        const wire = received.map((text) => {
          const match = text.match(
            /^([\s\S]*)\n<system-update>\nCurrent task facts \(host observations, not new requirements\): (\{[^\n]*\})\n<\/system-update>$/,
          )
          expect(match).not.toBeNull()
          return { prompt: match![1], facts: JSON.parse(match![2]) }
        })
        expect(wire.map((entry) => entry.prompt)).toEqual(
          chain.prompts.map((prompt) => (version ? `${briefing}\n\n${prompt}` : prompt)),
        )
        expect(JSON.stringify(chain.prompts)).toBe(original)
        const manifest = await Bun.file(path.join(root, "manifest.json")).json()
        expect(manifest.chain).toBe(chain.id)
        expect(manifest.promptsHash).toBe(
          createHash("sha256")
            .update(JSON.stringify(wire.map((entry) => entry.prompt)))
            .digest("hex"),
        )
        if (version) {
          expect(manifest.briefing).toBe(version)
          expect(manifest.originalPromptsHash).toBe(createHash("sha256").update(original).digest("hex"))
          expect(manifest.promptHashes).toEqual(
            wire.map((entry) => createHash("sha256").update(entry.prompt).digest("hex")),
          )
        } else {
          expect(manifest).not.toHaveProperty("briefing")
          expect(manifest).not.toHaveProperty("originalPromptsHash")
          expect(manifest).not.toHaveProperty("promptHashes")
        }
        for (let stage = 1; stage <= 5; stage++) {
          const session = await Bun.file(path.join(root, `stage-${stage}`, "session.json")).json()
          expect(session.stopped).toMatchObject({ remaining: [], controllerExit: 0 })
          expect(wire[stage - 1].facts.sourceRequest).toBe(session.admission.id)
          if (scenario.chain === "build-v2") {
            const grade = await Bun.file(path.join(root, `stage-${stage}`, "grade.json")).json()
            expect(grade.chain).toBe("build-v2")
            const verdict = await Bun.file(path.join(root, `stage-${stage}`, "host-verdict.json")).json()
            if (stage === 1) {
              if (!grade.pass)
                console.error(JSON.stringify({ grade, verdict, evidence: session.observation.turnEvidence }))
              expect(grade.pass).toBe(true)
            }
            expect(verdict.binding.chain).toBe("build-v2")
          }
        }
      } finally {
        await provider.stop(true)
      }
    },
    240000,
  )
