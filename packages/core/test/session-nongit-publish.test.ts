import { expect, test } from "bun:test"
import path from "path"
import { createHash } from "crypto"
import { tmpdir } from "./fixture/tmpdir"

for (const existing of [false, true])
  for (const prior of [false, true])
    test(`real Session publish/restart undo/redo/conflict: existing=${existing}, prior=${prior}`, async () => {
      await using temp = await tmpdir()
      const project = path.join(temp.path, "project")
      const candidate = path.join(project, "candidate.json")
      const final = path.join(project, "final.json")
      const check = path.join(project, "task_check.cjs")
      await Bun.write(
        check,
        'const fs=require("node:fs"),assert=require("node:assert/strict");assert.deepEqual(JSON.parse(fs.readFileSync(__dirname+"/candidate.json","utf8")),[1,2]);console.log("candidate assertions passed")',
      )
      if (existing) await Bun.write(final, "[0]")
      const write = { name: "write", input: { path: "candidate.json", content: "[1,2]" } }
      const steps = [
        write,
        ...(prior ? [undefined] : []),
        {
          name: "bash",
          input: {
            command: `node "${check.replaceAll("\\", "/")}"`,
            verification: "test",
            verification_targets: [candidate, check],
            verification_assertions: [check],
            verification_requirements: ["candidate parses as the exact requested two-element JSON array"],
          },
        },
        {
          name: "publish_artifact",
          input: {
            candidate: "candidate.json",
            path: "final.json",
            check: "task_check",
            expectedDigest: existing ? createHash("sha256").update("[0]").digest("hex") : null,
          },
        },
        undefined,
      ]
      let calls = 0
      await using provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          const step = steps[calls++]
          const delta = step
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: step.name === "bash" ? "task_check" : step.name,
                    type: "function",
                    function: { name: step.name, arguments: JSON.stringify(step.input) },
                  },
                ],
              }
            : { content: "Done." }
          return new Response(
            `data: ${JSON.stringify({ id: "publish", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "publish", choices: [{ index: 0, delta: {}, finish_reason: step ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      await Bun.write(
        path.join(project, "zaovra.json"),
        JSON.stringify({
          formatter: false,
          lsp: false,
          permission: { "*": "allow" },
          provider: {
            audit: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
              models: { "audit-model": { limit: { context: 128000, output: 1024 } } },
            },
          },
        }),
      )
      for (const phase of ["publish", "restore", "conflict"]) {
        const child = Bun.spawn(
          [
            process.execPath,
            path.join(import.meta.dir, "fixture/session-nongit-publish.ts"),
            phase,
            project,
            String(prior),
          ],
          {
            env: {
              ...process.env,
              XDG_DATA_HOME: path.join(temp.path, "data"),
              XDG_CONFIG_HOME: path.join(temp.path, "config"),
              XDG_CACHE_HOME: path.join(temp.path, "cache"),
              XDG_STATE_HOME: path.join(temp.path, "state"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(code, stdout + stderr).toBe(0)
      }
      const published = await Bun.file(path.join(project, "publish-evidence.json")).json()
      expect(published.diffs.map((item: { path: string }) => item.path).sort()).toEqual(
        prior ? ["candidate.json", "final.json"] : ["final.json"],
      )
      expect(published.tools.map((item: { name: string }) => item.name)).toEqual(["write", "bash", "publish_artifact"])
      expect(published.tools.every((item: { status: string }) => item.status === "completed")).toBe(true)
      const restored = await Bun.file(path.join(project, "restore-evidence.json")).json()
      expect(restored.undone).toEqual({ candidate: prior ? "[1,2]" : null, final: existing ? "[0]" : null })
      expect(restored.redone).toEqual({ candidate: null, final: "[1,2]" })
      const conflict = await Bun.file(path.join(project, "conflict-evidence.json")).json()
      expect(conflict).toEqual({ rejected: true, final: "external", candidate: null, cleaned: true })
      if (process.env.Y_NONGIT_EVIDENCE)
        await Bun.write(
          path.join(process.env.Y_NONGIT_EVIDENCE, `session-publish-${existing}-${prior}.json`),
          JSON.stringify({ published, restored, conflict, loopbackRequests: calls, realModelRequests: 0 }),
        )
    }, 120000)
