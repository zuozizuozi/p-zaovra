import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"

test("real Session API retains nongit diffs across process restart, reverses undo and cleans private backup on delete", async () => {
  await using temp = await tmpdir()
  const project = path.join(temp.path, "project")
  await Bun.write(path.join(project, "existing.txt"), "before\n")
  let calls = 0
  await using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++
      const tools = calls === 1
      const delta = tools
        ? {
            tool_calls: [
              {
                index: 0,
                id: "write-existing",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ path: "existing.txt", content: "after\n", expectedContent: "before\n" }),
                },
              },
              {
                index: 1,
                id: "write-new",
                type: "function",
                function: { name: "write", arguments: JSON.stringify({ path: "new.txt", content: "created\n" }) },
              },
            ],
          }
        : { content: "Files updated." }
      return new Response(
        `data: ${JSON.stringify({ id: "nongit", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "nongit", choices: [{ index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
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
  for (const phase of ["write", "restore"]) {
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixture/session-nongit-restore.ts"), phase, project],
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
  const first = await Bun.file(path.join(project, "write-evidence.json")).json()
  expect(first.diffs.map((file: { path: string }) => file.path).sort()).toEqual(["existing.txt", "new.txt"])
  const result = await Bun.file(path.join(project, "restore-evidence.json")).json()
  expect(result.before).toEqual(first.diffs)
  expect(result.undone).toEqual({ existing: "before\n", newExists: false })
  expect(result.redone).toEqual({ existing: "after\n", new: "created\n" })
  expect(result.hadBackup).toBe(true)
  expect(result.cleaned).toBe(true)
  if (process.env.Y_NONGIT_EVIDENCE)
    await Bun.write(
      path.join(process.env.Y_NONGIT_EVIDENCE, "session-nongit-restore.json"),
      JSON.stringify({ first, result, loopbackRequests: calls, realModelRequests: 0 }),
    )
}, 120000)
