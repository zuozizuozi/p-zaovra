import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

test.each(["clean", "crash", "stream-crash"])(
  "new processes recover durable inputs after %s exit",
  async (exit) => {
    await using tmp = await tmpdir()
    let requests = 0
    await using provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 30,
      fetch() {
        requests++
        const chunk = (delta: object, finish_reason: string | null = null) =>
          `data: ${JSON.stringify({ id: "persistence", object: "chat.completion.chunk", created: 1, model: "audit-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        if (exit === "stream-crash" && requests === 1) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(chunk({ role: "assistant", content: "PARTIAL_RESPONSE" })))
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        return new Response(
          chunk({ role: "assistant", content: "PERSISTED_MODEL_RESPONSE" }) + chunk({}, "stop") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    await Bun.write(
      path.join(tmp.path, "zaovra.json"),
      JSON.stringify({
        formatter: false,
        lsp: false,
        provider: {
          audit: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
            models: { "audit-model": { limit: { context: 32000, output: 1024 } } },
          },
        },
      }),
    )
    for (const phase of [
      "admit",
      "reconcile",
      ...(exit === "stream-crash" ? ["execute-crash", "verify-crash"] : []),
      "execute",
      "verify",
    ]) {
      const child = Bun.spawn(
        [process.execPath, path.join(import.meta.dir, "fixture/session-persistence-process.ts"), phase, tmp.path, exit],
        {
          env: {
            ...process.env,
            XDG_DATA_HOME: path.join(tmp.path, "data"),
            XDG_CONFIG_HOME: path.join(tmp.path, "config"),
            XDG_CACHE_HOME: path.join(tmp.path, "cache"),
            XDG_STATE_HOME: path.join(tmp.path, "state"),
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
      const crashed = (phase === "admit" && exit === "crash") || phase === "execute-crash"
      if (crashed) expect(code).not.toBe(0)
      if (!crashed) expect(code, `${phase}\n${stdout}\n${stderr}`).toBe(0)
      if (phase === "verify-crash") {
        const before = await Bun.file(path.join(tmp.path, "execute-crash.json")).json()
        const after = await Bun.file(path.join(tmp.path, "verify-crash.json")).json()
        expect(before.streamed).toBe(true)
        expect(JSON.stringify(before.context)).toContain("PARTIAL_RESPONSE")
        expect(JSON.stringify(before.durableContext)).not.toContain("PARTIAL_RESPONSE")
        expect(after.context).toEqual(before.durableContext)
        expect(after.active).toEqual([])
        expect(requests).toBe(1)
      }
    }
    const admitted = await Bun.file(path.join(tmp.path, "admit.json")).json()
    const recovered = await Bun.file(path.join(tmp.path, "reconcile.json")).json()
    expect((await Bun.file(path.join(tmp.path, "sessions.db")).bytes()).byteLength).toBeGreaterThan(0)
    expect(recovered.adopted.title).toBe("Persistent recovery session")
    expect(recovered.retried).toEqual(admitted.admitted)
    expect(recovered.cancelled).toEqual(admitted.cancelled)
    expect(recovered.pending).toEqual(admitted.pending)
    expect(recovered.pending.map((input: { id: string }) => input.id)).toEqual(["msg_disk_pending"])
    expect(recovered.active).toEqual([])
    expect(JSON.stringify(recovered.conflict)).toContain("Session.PromptConflictError")
    const executed = await Bun.file(path.join(tmp.path, "execute.json")).json()
    const verified = await Bun.file(path.join(tmp.path, "verify.json")).json()
    expect(executed.pending).toEqual([])
    expect(JSON.stringify(executed.context)).toContain("durable queued input")
    expect(JSON.stringify(executed.context)).not.toContain("cancelled queued input")
    expect(JSON.stringify(executed.context)).toContain("PERSISTED_MODEL_RESPONSE")
    expect(verified.context).toEqual(executed.context)
    expect(verified.pending).toEqual([])
    expect(verified.active).toEqual([])
    expect(requests).toBe(exit === "stream-crash" ? 2 : 1)
  },
  90_000,
)
