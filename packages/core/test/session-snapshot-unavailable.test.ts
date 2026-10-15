import { expect, test } from "bun:test"
import path from "node:path"
import { $ } from "bun"
import { tmpdir } from "./fixture/tmpdir"

test("real Session snapshots expose Windows layout B unavailability without failing a file write", async () => {
  await using tmp = await tmpdir()
  for (const layout of ["normal", "long"] as const) {
    const root =
      layout === "normal"
        ? path.join(tmp.path, layout)
        : path.join(tmp.path, "x".repeat(Math.max(1, 180 - tmp.path.length - 1)))
    const project = path.join(root, "project")
    await Bun.write(path.join(project, "tracked.txt"), "before\n")
    await $`git init`.cwd(project).quiet()
    await $`git -c user.name=Test -c user.email=test@zaovra.test -c commit.gpgsign=false add .`.cwd(project).quiet()
    await $`git -c user.name=Test -c user.email=test@zaovra.test -c commit.gpgsign=false commit -m initial`
      .cwd(project)
      .quiet()
    let calls = 0
    await using provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++
        const delta =
          calls === 1
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "snapshot-write",
                    type: "function",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({
                        path: path.join(project, "tracked.txt"),
                        content: "after\n",
                        expectedContent: "before\n",
                      }),
                    },
                  },
                ],
              }
            : { content: "File updated" }
        return new Response(
          `data: ${JSON.stringify({ id: "snapshot", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "snapshot", choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
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
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixture/session-combined-recovery.ts"), "snapshot", project],
      {
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(root, "data"),
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
    expect(code, stdout + stderr).toBe(0)
    expect(
      await Bun.file(path.join(project, "tracked.txt")).text(),
      await Bun.file(path.join(project, "snapshot.json")).text(),
    ).toBe("after\n")
    const result = await Bun.file(path.join(project, "snapshot.json")).json()
    const step = result.messages.find((item: { type: string }) => item.type === "assistant")
    expect(Boolean(step.snapshot?.start)).toBe(layout === "normal" || process.platform !== "win32")
    if (process.env.Y_SNAPSHOT_EVIDENCE)
      await Bun.write(path.join(process.env.Y_SNAPSHOT_EVIDENCE, `snapshot-${layout}.json`), JSON.stringify(result))
  }
}, 120_000)
