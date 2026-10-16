import path from "node:path"
import { expect, test } from "bun:test"
import { tmpdir } from "./fixture/tmpdir"

for (const mode of ["tail-before-exit", "exit-before-stop", "idle-stop", "input-before-stop"] as const)
  test(`production execution retains tail across ${mode} and a new task`, async () => {
    await using dir = await tmpdir()
    await Bun.write(
      path.join(dir.path, "old.cjs"),
      `require('fs').appendFileSync('old-count','once\\n');process.stdout.write('OLD_TAIL_中文🙂\\n');${mode === "tail-before-exit" || mode === "input-before-stop" ? "setInterval(()=>{},1000)" : "process.exit(0)"}`,
    )
    await Bun.write(
      path.join(dir.path, "new.cjs"),
      "require('fs').appendFileSync('new-count','once\\n');console.log('NEW_TAIL_中文🙂');process.exit(0)",
    )
    let newCalls = 0
    const bodies: string[] = []
    const done = (delta: object, reason = "stop") =>
      new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    const call = (name: string) =>
      done(
        {
          tool_calls: [
            {
              index: 0,
              id: `${name}-call`,
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({
                  command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" ${name}.cjs`,
                  description: `Run ${name} fixture`,
                }),
              },
            },
          ],
        },
        "tool_calls",
      )
    await using provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.text()
        bodies.push(body)
        if (body.includes("SECOND_TASK")) return ++newCalls === 1 ? call("new") : done({ content: "NEW_TASK_FINISHED" })
        if (bodies.length === 1) return call("old")
        if (mode === "idle-stop") return done({ content: "OLD_TASK_FINISHED" })
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"waiting"}}]}\n\n'),
              )
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    await Bun.write(
      path.join(dir.path, "zaovra.json"),
      JSON.stringify({
        formatter: false,
        lsp: false,
        permission: { "*": "allow" },
        compaction: { auto: false },
        provider: {
          audit: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
            models: { fixture: { limit: { context: 128000, output: 1024 } } },
          },
        },
      }),
    )
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixture/session-stop-tail.ts"), dir.path, mode],
      {
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(dir.path, "data"),
          XDG_CONFIG_HOME: path.join(dir.path, "config"),
          XDG_CACHE_HOME: path.join(dir.path, "cache"),
          XDG_STATE_HOME: path.join(dir.path, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      const result = await Bun.file(path.join(dir.path, "result.json")).json()
      if (process.env.ZAOVRA_TEST_EVIDENCE_DIR)
        await Bun.write(
          path.join(process.env.ZAOVRA_TEST_EVIDENCE_DIR, `u2-${mode}.json`),
          JSON.stringify({ result, bodies, newCalls }, null, 2),
        )
      expect(result.active).toEqual([])
      const tools = result.context.flatMap(
        (message: {
          type: string
          content?: Array<{
            type: string
            id: string
            state: { status: string; structured?: { exit?: number }; content?: unknown }
          }>
        }) => (message.type === "assistant" ? (message.content?.filter((part) => part.type === "tool") ?? []) : []),
      )
      const old = tools.find((tool: { id: string }) => tool.id === "old-call")
      const current = tools.find((tool: { id: string }) => tool.id === "new-call")
      expect(JSON.stringify(old)).toContain("OLD_TAIL_中文🙂")
      expect(old.state.status).toBe(mode === "tail-before-exit" || mode === "input-before-stop" ? "error" : "completed")
      if (mode !== "tail-before-exit" && mode !== "input-before-stop") expect(old.state.structured.exit).toBe(0)
      expect(current.state.status).toBe("completed")
      expect(current.state.structured.exit).toBe(0)
      expect(JSON.stringify(current)).toContain("NEW_TAIL_中文🙂")
      expect(await Bun.file(path.join(dir.path, "old-count")).text()).toBe("once\n")
      expect(await Bun.file(path.join(dir.path, "new-count")).text()).toBe("once\n")
      if (mode === "tail-before-exit" || mode === "input-before-stop") {
        expect(old.state.error.message).toContain("interrupted")
        expect(old.state.structured.exit).toBeUndefined()
      }
      expect(newCalls).toBe(2)
      expect(result.pending).toEqual([])
      if (mode === "input-before-stop") expect(result.stoppedPending).toHaveLength(1)
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
    }
  }, 60000)
