import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { runEvaluationSession } from "../../../../script/evaluation/memory/session"
import { tmpdir } from "../fixture/fixture"

const experiments = [
  { factor: "delivery-repair", value: "on" },
  { factor: "delivery-repair", value: "off" },
  { factor: "host-hint-style", value: "short" },
  { factor: "host-hint-language", value: "zh" },
  { factor: "accuracy-scale", value: "on" },
  { factor: "accuracy-scale", value: "off" },
] as const

for (const kernelExperiment of experiments)
  test.skipIf(process.platform !== "win32")(
    `evaluation factor reaches actual interactive backend: ${kernelExperiment.factor}/${kernelExperiment.value}`,
    async () => {
      await using tmp = await tmpdir()
      const directory = path.join(tmp.path, "workspace")
      const profile = path.join(tmp.path, "profile")
      const stage = path.join(tmp.path, "stage")
      await mkdir(directory)
      await mkdir(profile)
      await Bun.write(path.join(profile, ".evaluation-profile"), "zaovra-memory-evaluation-v1\n")
      const requests: string[] = []
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requests.push(await request.text())
          const chunk = (choices: unknown[], usage?: object) =>
            `data: ${JSON.stringify({ id: "factor-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices, usage })}\n\n`
          return new Response(
            chunk([
              {
                index: 0,
                delta: { role: "assistant", content: "Fixture stopped without creating the requested file." },
                finish_reason: null,
              },
            ]) +
              chunk([{ index: 0, delta: {}, finish_reason: "stop" }]) +
              // Deliberately priced synthetic usage admits the existing bounded repair allowance.
              // This is neither a real model invocation nor a measured token count.
              chunk([], {
                prompt_tokens: requests.length === 1 ? 600000 : 10,
                completion_tokens: 2,
                total_tokens: requests.length === 1 ? 600002 : 12,
              }) +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      try {
        await Bun.write(
          path.join(directory, "zaovra.json"),
          JSON.stringify({
            model: "factor-fixture/fixture-model",
            shell: "powershell",
            agent: { build: { steps: 8 } },
            memory: { enabled: false },
            provider: {
              "factor-fixture": {
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
                models: {
                  "fixture-model": { limit: { context: 1000000, output: 1024 }, cost: { input: 1, output: 2 } },
                },
              },
            },
          }),
        )
        // A quiescent, normally stopped turn is capturable even when delivery remains unverified.
        const result = await runEvaluationSession({
          directory,
          profile,
          stage,
          model: { id: "fixture-model", providerID: "factor-fixture" },
          prompt: "交付 result.json。",
          seconds: 30,
          kernelExperiment,
        })
        expect(result.stopped).toMatchObject({ remaining: [], controllerExit: 0 })
        expect(result.diagnostics.coverage.status).toBe("complete-through-cut")
        expect(await Bun.file(path.join(directory, "result.json")).exists()).toBe(false)
        // Read persisted events only after the independent backend Job has stopped.
        using db = new Database(path.join(profile, "sessions.sqlite"), { readonly: true })
        const created = db
          .query<{ data: string }, []>("select data from event where type = 'session.next.created.1'")
          .all()
        expect(created).toHaveLength(1)
        expect(JSON.parse(created[0].data)).toMatchObject({ budgetMode: "interactive", budgetPolicy: 2 })
        expect(JSON.parse(created[0].data).budget).toBeUndefined()
        const events = db
          .query<{ data: string }, []>("select data from event where type = 'session.next.synthetic.1' order by seq")
          .all()
        const repair = events.filter((event) => event.data.includes("Delivery contract review:"))
        const disabled = kernelExperiment.factor === "delivery-repair" && kernelExperiment.value === "off"
        expect(requests).toHaveLength(disabled ? 1 : 4)
        // Initial inspection plus three admission receipts and three settlement receipts.
        expect(repair.length).toBe(disabled ? 0 : 7)
        expect(requests[0]).not.toContain("One bounded delivery repair cycle;")
        if (!disabled) {
          expect(requests[1]).toContain("One bounded delivery repair cycle; 3 provider turns remain")
          expect(repair.at(-1)!.data).toContain('"decision":"unverified"')
          expect(repair.at(-1)!.data).toContain('"turns":3')
          const receipt = JSON.parse(repair.at(-1)!.data).host.receipt
          expect(receipt.spent).toBeLessThanOrEqual(receipt.allowance)
          expect(receipt.allowance).toBeGreaterThan(0)
          if (kernelExperiment.factor === "host-hint-style") {
            expect(requests[1]).toContain("Use local tools only for these original gaps")
            expect(requests[1]).not.toContain("Repair only these concrete original requirements")
          } else if (kernelExperiment.factor === "host-hint-language") {
            expect(requests[1]).toContain("仅用可用本地工具修复这些明确的原始要求")
            expect(requests[1]).not.toContain("Repair only these concrete original requirements")
          } else {
            expect(requests[1]).toContain("Repair only these concrete original requirements")
          }
        }
        // Interactive/policy2 has no implicit wall-clock deadline. Switching scale cannot
        // create a checkpoint; core clock-boundary tests cover its separately required budget.
        expect(requests.join("\n")).not.toContain("Wall-clock delivery checkpoint:")
        expect(events.some((event) => event.data.includes('"kind":"budget-checkpoint"'))).toBe(false)
        console.log(
          JSON.stringify({
            kernelExperiment,
            providerRequests: requests.length,
            receipts: repair.map((event) => JSON.parse(event.data).host.receipt),
            wireHints: requests.map((request) =>
              JSON.parse(request).messages.filter(
                (message: { content?: unknown }) =>
                  typeof message.content === "string" && message.content.includes("One bounded delivery repair cycle;"),
              ),
            ),
            checkpoint: false,
            stopped: result.stopped,
            artifactExists: false,
          }),
        )
      } finally {
        await provider.stop(true)
      }
    },
    40000,
  )
