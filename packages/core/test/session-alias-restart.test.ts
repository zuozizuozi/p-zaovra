import path from "node:path"
import { test, expect } from "bun:test"
import { tmpdir } from "./fixture/tmpdir"

test("alias compaction survives mid-stream and committed crashes without tool or usage replay", async () => {
  await using dir = await tmpdir()
  await Bun.write(path.join(dir.path, "append.cjs"), "require('fs').appendFileSync('side-effect.txt','once\\n')")
  const bodies: Array<{ model: string; messages: unknown }> = []
  let turns = 0
  let summaries = 0
  const interrupted = Promise.withResolvers<void>()
  const done = (delta: object, reason = "stop") =>
    new Response(
      `data: ${JSON.stringify({ id: "alias-fixture", object: "chat.completion.chunk", created: 1, model: "wire-fixture", choices: [{ index: 0, delta, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  await using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string; messages: unknown }
      bodies.push(body)
      if (JSON.stringify(body).includes("Create a new anchored summary")) {
        summaries++
        if (summaries === 1)
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"index":0,"delta":{"content":"HALF_SUMMARY_MUST_NOT_COMMIT"}}]}\n\n',
                  ),
                )
                interrupted.resolve()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        return done({
          content:
            "## Objective\nORIGINAL_REQUIREMENT append exactly once\n## Important Details\nLATEST_CONSTRAINT preserve BOM\n## Work State\n### Completed\nappend tool completed, do not replay\n### Active\nFinish response\n### Blocked\nNone\n## Next Move\nFinish\n## Relevant Files\nside-effect.txt",
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
                    description: "Append a single marker",
                  }),
                },
              },
            ],
          },
          "tool_calls",
        )
      return done({ content: turns === 2 ? "OLD_OBSERVATIONS ".repeat(10000) : "FINAL_AFTER_RESTART" })
    },
  })
  await Bun.write(
    path.join(dir.path, "zaovra.json"),
    JSON.stringify({
      formatter: false,
      lsp: false,
      permission: { "*": "allow" },
      compaction: { auto: true, keep: { tokens: 20 } },
      provider: {
        audit: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
          models: { friendly: { id: "wire-fixture", limit: { context: 32000, output: 1024 } } },
        },
      },
    }),
  )
  const run = (phase: string) =>
    Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/session-alias-restart.ts"), dir.path, phase], {
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(dir.path, "data"),
        XDG_CONFIG_HOME: path.join(dir.path, "config"),
        XDG_CACHE_HOME: path.join(dir.path, "cache"),
        XDG_STATE_HOME: path.join(dir.path, "state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
  const settled = async (child: ReturnType<typeof run>, crash = false) => {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (crash) expect(code).not.toBe(0)
    if (!crash) expect(code, `${stdout}\n${stderr}`).toBe(0)
  }
  await settled(run("seed"))
  const seed = await Bun.file(path.join(dir.path, "seed.json")).json()
  const child = run("partial")
  try {
    await Promise.race([
      interrupted.promise,
      child.exited.then((code) => {
        throw Error(`partial exited early ${code}`)
      }),
    ])
    await settled(run("inspect-partial"))
    const partial = await Bun.file(path.join(dir.path, "inspect-partial.json")).json()
    expect(JSON.stringify(partial.context)).not.toContain("HALF_SUMMARY_MUST_NOT_COMMIT")
    expect(partial.context.filter((message: { type: string }) => message.type === "compaction")).toHaveLength(0)
    expect(partial.usage.total.total).toBe(seed.usage.total.total)
    child.kill("SIGKILL")
    await settled(child, true)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  const beforeInspect = bodies.length
  await settled(run("inspect-crash"))
  expect(bodies.length).toBe(beforeInspect)
  await settled(run("commit"), true)
  const committed = await Bun.file(path.join(dir.path, "commit.json")).json()
  const beforeRestart = bodies.length
  await settled(run("inspect-commit"))
  const inspected = await Bun.file(path.join(dir.path, "inspect-commit.json")).json()
  expect(bodies.length).toBe(beforeRestart)
  expect(inspected.usage.total).toEqual(committed.usage.total)
  expect(inspected.context).toEqual(committed.context)
  expect(inspected.active).toEqual([])
  expect(committed.context.filter((message: { type: string }) => message.type === "compaction")).toHaveLength(1)
  expect(committed.usage.total.total - seed.usage.total.total).toBe(110)
  await settled(run("resume"))
  const resumed = await Bun.file(path.join(dir.path, "resume.json")).json()
  expect(resumed.usage.total.total - committed.usage.total.total).toBe(110)
  expect(summaries).toBe(2)
  expect(turns).toBe(3)
  expect(bodies.every((body) => body.model === "wire-fixture")).toBe(true)
  expect(JSON.stringify(bodies.at(-1))).toContain("ORIGINAL_REQUIREMENT")
  expect(JSON.stringify(bodies.at(-1))).toContain("LATEST_CONSTRAINT")
  expect(JSON.stringify(bodies.at(-1))).not.toContain("HALF_SUMMARY_MUST_NOT_COMMIT")
  expect(await Bun.file(path.join(dir.path, "side-effect.txt")).text()).toBe("once\n")
  if (process.env.ZAOVRA_TEST_EVIDENCE_DIR)
    await Bun.write(
      path.join(process.env.ZAOVRA_TEST_EVIDENCE_DIR, "u3-evidence.json"),
      JSON.stringify(
        {
          seed,
          committed,
          inspected,
          resumed,
          bodies,
          turns,
          summaries,
          interruptedUsage: "not reported; not asserted zero",
        },
        null,
        2,
      ),
    )
}, 120000)
