import { afterEach, expect, test } from "bun:test"
import { Revert } from "@zaovra-ai/schema/revert"
import { RelativePath } from "@zaovra-ai/schema/schema"
import { Session } from "@zaovra-ai/schema/session"
import { SessionMessage } from "@zaovra-ai/schema/session-message"
import { Context, Effect, Schema } from "effect"
import fs from "node:fs/promises"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { fingerprint } from "../fixture/revert-plan-fingerprint"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("810 read-only fingerprints isolate only the exact global runtime log", async () => {
  await using tmp = await tmpdir()
  const project = path.join(tmp.path, "project")
  const data = path.join(tmp.path, "data")
  const runtimeLog = path.join(data, "log", "zaovra.log")
  const projectLog = path.join(project, "log", "zaovra.log")
  const sidecar = path.join(data, "state.db-wal")
  await fs.mkdir(path.dirname(projectLog), { recursive: true })
  await fs.mkdir(path.dirname(runtimeLog), { recursive: true })
  await Bun.write(projectLog, "project-before")
  await Bun.write(runtimeLog, "runtime-before")
  await Bun.write(sidecar, "durable-before")
  const before = await fingerprint([project, data], runtimeLog)
  await Bun.write(runtimeLog, "runtime-after")
  const logged = await fingerprint([project, data], runtimeLog)
  expect(logged.hash).toBe(before.hash)
  expect(logged.combinedHash).not.toBe(before.combinedHash)
  await Bun.write(projectLog, "project-after")
  expect((await fingerprint([project, data], runtimeLog)).hash).not.toBe(before.hash)
  await Bun.write(projectLog, "project-before")
  await Bun.write(sidecar, "durable-after")
  expect((await fingerprint([project, data], runtimeLog)).hash).not.toBe(before.hash)
  await Bun.write(sidecar, "durable-before")
  await Bun.write(path.join(data, "another.log"), "unclassified-write")
  expect((await fingerprint([project, data], runtimeLog)).hash).not.toBe(before.hash)
})

for (const git of [false, true])
  test(`789 HTTP plan follows actual write and BashTool execution (git=${git})`, async () => {
    let providerRequests = 0
    await using provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        providerRequests++
        const tools = providerRequests === 1
        const delta = tools
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "write-existing",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({
                      path: "existing.txt",
                      content: "tool-after",
                      expectedContent: "tool-before",
                    }),
                  },
                },
                {
                  index: 1,
                  id: "write-new",
                  type: "function",
                  function: { name: "write", arguments: JSON.stringify({ path: "new.txt", content: "tool-created" }) },
                },
                {
                  index: 2,
                  id: "bash-change",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command: "node -e \"require('fs').writeFileSync('command.txt','cli-after')\"",
                      description: "Change command.txt inside the isolated test project",
                      timeout: 10000,
                    }),
                  },
                },
              ],
            }
          : { content: "The requested fixture work is complete." }
        return new Response(
          `data: ${JSON.stringify({ id: "revert-http", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "revert-http", choices: [{ index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    await using tmp = await tmpdir({
      git,
      config: {
        formatter: false,
        lsp: false,
        permission: { "*": "allow" },
        provider: {
          "audit-revert": {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
            models: { "audit-model": { limit: { context: 128000, output: 1024 } } },
          },
        },
      },
    })
    await Bun.write(path.join(tmp.path, "existing.txt"), "tool-before")
    await Bun.write(path.join(tmp.path, "command.txt"), "cli-before")
    if (git) {
      for (const args of [
        ["add", "existing.txt", "command.txt"],
        ["commit", "-m", "fixture files"],
      ]) {
        const child = Bun.spawn(["git", ...args], { cwd: tmp.path, stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(code, stdout + stderr).toBe(0)
      }
    }
    const context = Context.empty() as Context.Context<unknown>
    await using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => HttpApiApp.webHandler().handler(request, context),
    })
    const request = (route: string, body?: object, method = body ? "POST" : "GET") =>
      fetch(`http://127.0.0.1:${server.port}${route}`, {
        method,
        headers: { "content-type": "application/json", "x-zaovra-directory": encodeURIComponent(tmp.path) },
        body: body ? JSON.stringify(body) : undefined,
      })
    const created = await request("/api/session", {
      location: { directory: tmp.path },
      model: { providerID: "audit-revert", id: "audit-model" },
    })
    expect(created.status, await created.clone().text()).toBe(200)
    const session = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(await created.json()).data
    const route = `/api/session/${session.id}`
    const messageID = `msg_revert_http_${git}`
    const admitted = await request(`${route}/prompt`, {
      id: messageID,
      prompt: { text: "Update both files and use bash." },
    })
    expect(admitted.status, await admitted.clone().text()).toBe(200)
    expect((await request(`${route}/wait`, undefined, "POST")).status).toBe(204)
    const messages = async () => {
      const response = await request(`${route}/context`)
      expect(response.status).toBe(200)
      return Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(SessionMessage.Message) }))(
        await response.json(),
      ).data
    }
    const original = await messages()
    const tools = original.flatMap((message) =>
      message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
    )
    expect(tools.map((tool) => [tool.name, tool.state.status]).sort()).toEqual([
      ["bash", "completed"],
      ["write", "completed"],
      ["write", "completed"],
    ])
    expect(await Bun.file(path.join(tmp.path, "existing.txt")).text()).toBe("tool-after")
    expect(await Bun.file(path.join(tmp.path, "new.txt")).text()).toBe("tool-created")
    expect(await Bun.file(path.join(tmp.path, "command.txt")).text()).toBe("cli-after")
    expect(providerRequests).toBe(2)
    const cold = await coldPlan(tmp.path, session.id, messageID)
    expect(cold.coverage).toBe(git ? "snapshot" : "file-tools")
    expect(cold.files).toEqual(
      (git ? ["command.txt", "existing.txt", "new.txt"] : ["existing.txt", "new.txt"]).map((file) =>
        RelativePath.make(file),
      ),
    )
    expect(providerRequests).toBe(2)
    const preview = await request(`${route}/revert/plan/${messageID}`)
    expect(preview.status, await preview.clone().text()).toBe(200)
    const plan = Schema.decodeUnknownSync(Schema.Struct({ data: Revert.Plan }))(await preview.json()).data
    expect(plan.coverage).toBe(git ? "snapshot" : "file-tools")
    expect(plan.files).toEqual(
      (git ? ["command.txt", "existing.txt", "new.txt"] : ["existing.txt", "new.txt"]).map((file) =>
        RelativePath.make(file),
      ),
    )
    // Reading and abandoning the preview does not invoke stage or hide messages.
    expect(await messages()).toEqual(original)
    expect(await Bun.file(path.join(tmp.path, "existing.txt")).text()).toBe("tool-after")
    expect(providerRequests).toBe(2)
    expect((await request(`${route}/revert/stage`, { messageID, planToken: "stale-plan" })).status).toBe(409)
    expect(await Bun.file(path.join(tmp.path, "existing.txt")).text()).toBe("tool-after")
    const stage = () => request(`${route}/revert/stage`, { messageID, planToken: plan.token })
    expect((await stage()).status).toBe(200)
    expect(await Bun.file(path.join(tmp.path, "existing.txt")).text()).toBe("tool-before")
    expect(await Bun.file(path.join(tmp.path, "new.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(tmp.path, "command.txt")).text()).toBe(git ? "cli-before" : "cli-after")
    if (!git) {
      await Bun.write(path.join(tmp.path, "existing.txt"), "external-edit")
      const failed = await request(`${route}/revert/clear`, undefined, "POST")
      expect(failed.status).toBe(500)
      expect(await failed.text()).toContain("existing.txt")
      expect(await Bun.file(path.join(tmp.path, "existing.txt")).text()).toBe("external-edit")
      await Bun.write(path.join(tmp.path, "existing.txt"), "tool-before")
    }
    expect((await request(`${route}/revert/clear`, undefined, "POST")).status).toBe(204)
    expect(await Bun.file(path.join(tmp.path, "existing.txt")).text()).toBe("tool-after")
    expect(await Bun.file(path.join(tmp.path, "new.txt")).text()).toBe("tool-created")
    expect(await messages()).toEqual(original)
    expect((await stage()).status).toBe(200)
    // The real App submit flow commits the staged boundary before admission.
    // A raw prompt request alone deliberately does not commit a revert.
    expect((await request(`${route}/revert/commit`, undefined, "POST")).status).toBe(204)
    const nextID = `msg_revert_next_${git}`
    expect(
      (await request(`${route}/prompt`, { id: nextID, prompt: { text: "Continue after this reset." } })).status,
    ).toBe(200)
    expect((await request(`${route}/wait`, undefined, "POST")).status).toBe(204)
    expect((await request(`${route}/revert/clear`, undefined, "POST")).status).toBe(204)
    const remaining = await messages()
    expect(remaining.some((message) => message.id === nextID)).toBe(true)
    expect(
      original
        .filter((message) => message.type === "assistant")
        .every((old) => !remaining.some((message) => message.id === old.id)),
    ).toBe(true)
    expect(await Bun.file(path.join(tmp.path, "existing.txt")).text()).toBe("tool-before")
    expect(await Bun.file(path.join(tmp.path, "new.txt")).exists()).toBe(false)
    expect(providerRequests).toBe(3)
    const emptyPreview = await request(`${route}/revert/plan/${nextID}`)
    expect(emptyPreview.status).toBe(200)
    expect(
      Schema.decodeUnknownSync(Schema.Struct({ data: Revert.Plan }))(await emptyPreview.json()).data.files,
    ).toEqual([])
  }, 120000)

async function coldPlan(directory: string, sessionID: string, messageID: string) {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "cold.db")
  const { Database } = await import("@zaovra-ai/core/database/database")
  const { AppRuntime } = await import("../../src/effect/app-runtime")
  // Export actual tool-produced records, without synthesizing assistants.
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.run(`VACUUM INTO '${filename.replaceAll("'", "''")}'`)
    }),
  )
  const child = Bun.spawn(
    [
      process.execPath,
      path.resolve(import.meta.dir, "../fixture/revert-plan-cold-http.ts"),
      filename,
      directory,
      sessionID,
      messageID,
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, ZAOVRA_DB: filename },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stdout + stderr).toBe(0)
    const line = stdout.split(/\r?\n/).find((line) => line.startsWith("cold-http-plan:"))
    if (!line) throw new Error("Cold HTTP result missing: " + stdout + stderr)
    // Keep per-file evidence even when a read-only assertion below fails.
    console.log(`cold-http-plan ${sessionID}: ` + line.slice("cold-http-plan:".length))
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        status: Schema.Number,
        body: Schema.String,
        dbBefore: Schema.String,
        dbAfter: Schema.String,
        treeBefore: Schema.String,
        treeAfter: Schema.String,
      }),
    )(JSON.parse(line.slice("cold-http-plan:".length)))
    expect(result.status, result.body).toBe(200)
    expect(result.dbAfter).toBe(result.dbBefore)
    expect(result.treeAfter).toBe(result.treeBefore)
    return Schema.decodeUnknownSync(Schema.Struct({ data: Revert.Plan }))(JSON.parse(result.body)).data
  } finally {
    child.kill()
    await child.exited
  }
}
