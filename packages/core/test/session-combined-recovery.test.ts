import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

test("combined recovery survives a committed compaction crash without replaying side effects or usage", async () => {
  await using tmp = await tmpdir()
  const bodies: string[] = []
  let turns = 0
  let summaries = 0
  const chunk = (delta: object, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ id: "combined", object: "chat.completion.chunk", created: 1, model: "audit-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  const done = (delta: object, reason = "stop") =>
    new Response(
      chunk(delta) +
        chunk({}, reason) +
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  await Bun.write(path.join(tmp.path, "append.cjs"), "require('node:fs').appendFileSync('side-effect.txt', 'once\\n')")
  await using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text()
      bodies.push(body)
      if (body.includes("Create a new anchored summary")) {
        summaries++
        return done({
          content:
            "## Objective\nORIGINAL_REQUIREMENT\n## Important Details\nLATEST_CONSTRAINT preserve BOM\n## Work State\n### Completed\nAppend done once\n### Active\nResume\n### Blocked\nNone\n## Next Move\nResume explicitly\n## Relevant Files\nside-effect.txt",
        })
      }
      turns++
      if (turns === 1)
        return done(
          {
            tool_calls: [
              {
                index: 0,
                id: "append-once",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" append.cjs`,
                    description: "Append one marker",
                  }),
                },
              },
            ],
          },
          "tool_calls",
        )
      if (turns === 2) return done({ reasoning_content: "bounded reasoning" }, "length")
      if (turns === 3)
        return new Response(chunk({ content: "PARTIAL_TAIL" }), { headers: { "content-type": "text/event-stream" } })
      if (turns === 4)
        return Response.json({ error: { message: "retryable fixture", type: "server_error" } }, { status: 503 })
      return done({ content: turns === 5 ? "RETAINED_TAIL before crash" : "FINAL after explicit resume" })
    },
  })
  await Bun.write(
    path.join(tmp.path, "zaovra.json"),
    JSON.stringify({
      formatter: false,
      lsp: false,
      permission: { "*": "allow" },
      compaction: { auto: false, keep: { tokens: 20 } },
      provider: {
        audit: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
          models: { "audit-model": { limit: { context: 128000, output: 1024 } } },
        },
      },
    }),
  )
  for (const phase of ["before", "inspect", "resume"]) {
    const count = bodies.length
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixture/session-combined-recovery.ts"), phase, tmp.path],
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
    if (phase === "before") expect(code).not.toBe(0)
    if (phase !== "before") expect(code, `${stdout}\n${stderr}`).toBe(0)
    if (phase === "inspect") expect(bodies.length).toBe(count)
  }
  const before = await Bun.file(path.join(tmp.path, "before.json")).json()
  const inspect = await Bun.file(path.join(tmp.path, "inspect.json")).json()
  const resumed = await Bun.file(path.join(tmp.path, "resume.json")).json()
  expect(before.compacted).toBe(true)
  expect(summaries).toBe(1)
  expect(before.attempts).toEqual([["reasoning-exhaustion", 1]])
  expect(inspect.before.attempts).toEqual(before.attempts)
  expect(inspect.before.context).toEqual(before.context)
  expect(inspect.before.usage.total).toEqual(before.usage.total)
  expect(inspect.before.history).toEqual(before.history)
  expect(inspect.before.active).toEqual([])
  expect(resumed.before.usage.total).toEqual(before.usage.total)
  expect(JSON.stringify(before.history)).toContain("PARTIAL_TAIL")
  expect(bodies.at(-1)).toContain("LATEST_CONSTRAINT")
  expect(bodies.at(-1)).toContain("RETAINED_TAIL")
  expect(bodies.at(-1)).toContain("ORIGINAL_REQUIREMENT")
  expect(await Bun.file(path.join(tmp.path, "side-effect.txt")).text()).toBe("once\n")
  expect(resumed.usage.total.total - before.usage.total.total).toBe(110)
  expect(turns).toBe(6)
}, 120_000)
