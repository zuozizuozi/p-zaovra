import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"

for (const mode of ["replace", "delete", "interrupt"])
  test(`real Session recovers healthy diffs after ${mode}, including process restart`, async () => {
    await using temp = await tmpdir()
    const project = path.join(temp.path, "project")
    await Bun.write(path.join(project, "target.txt"), "before")
    const first =
      mode === "delete"
        ? { name: "apply_patch", input: { patchText: "*** Begin Patch\n*** Delete File: target.txt\n*** End Patch" } }
        : { name: "write", input: { path: "target.txt", content: "ours", expectedContent: "before" } }
    let calls = 0
    await using provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        const call = calls++
        const recovery = mode === "interrupt" ? call === 1 : call === 2
        const step =
          call === 0
            ? first
            : recovery
              ? {
                  name: "write",
                  input: {
                    path: mode === "interrupt" ? "healthy.txt" : "target.txt",
                    content: "recovered",
                    ...(mode === "interrupt" ? {} : { expectedContent: "external" }),
                  },
                }
              : mode === "interrupt" && call === 3
                ? {
                    name: "write",
                    input: { path: "target.txt", content: "must not write", expectedContent: "partial unknown" },
                  }
                : undefined
        const delta = step
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `tool-${call}`,
                  type: "function",
                  function: { name: step.name, arguments: JSON.stringify(step.input) },
                },
              ],
            }
          : { content: "Done." }
        return new Response(
          `data: ${JSON.stringify({ id: "recovery", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "recovery", choices: [{ index: 0, delta: {}, finish_reason: step ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
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
    for (const phase of ["reject", "continue"]) {
      const child = Bun.spawn(
        [process.execPath, path.join(import.meta.dir, "fixture/session-nongit-recovery.ts"), phase, project, mode],
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
      expect(code, stdout + stderr).toBe(phase === "reject" && mode === "interrupt" ? 73 : 0)
    }
    const result = await Bun.file(path.join(project, "recovery-evidence.json")).json()
    if (mode !== "interrupt") {
      const rejected = await Bun.file(path.join(project, "rejected.json")).json()
      expect(rejected.diffs).toEqual([])
      expect(
        rejected.messages
          .flatMap((message: { type: string; content?: { type: string; state: { status: string } }[] }) =>
            message.type === "assistant"
              ? (message.content?.filter((part) => part.type === "tool").map((part) => part.state.status) ?? [])
              : [],
          )
          .every((status: string) => status !== "completed"),
      ).toBe(true)
    }
    expect(result.diffs.map((file: { path: string }) => file.path)).toEqual([
      mode === "interrupt" ? "healthy.txt" : "target.txt",
    ])
    expect(result.undone).toBe(mode === "interrupt" ? null : "external")
    expect(result.redone).toBe("recovered")
    expect(result.original).toBe(mode === "interrupt" ? "partial unknown" : "recovered")
    expect(result.pending).toBe(mode === "interrupt" ? 1 : 0)
    if (mode === "interrupt") {
      expect(result.pendingOriginal).toBe("before")
      expect(result.uncertainEntries).toBe(0)
    }
    expect(result.isolatedRejected).toBe(mode === "interrupt")
    expect(result.cleaned).toBe(true)
    if (process.env.Y_NONGIT_EVIDENCE)
      await Bun.write(
        path.join(process.env.Y_NONGIT_EVIDENCE, `session-recovery-${mode}.json`),
        JSON.stringify({ ...result, loopbackRequests: calls, realModelRequests: 0 }),
      )
  }, 120000)
