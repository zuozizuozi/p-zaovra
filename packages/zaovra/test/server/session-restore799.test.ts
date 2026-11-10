import { afterEach, expect, test } from "bun:test"
import { Revert } from "@zaovra-ai/schema/revert"
import { RelativePath } from "@zaovra-ai/schema/schema"
import { Session } from "@zaovra-ai/schema/session"
import { SessionMessage } from "@zaovra-ai/schema/session-message"
import { Context, Effect, Schema } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

for (const git of [false, true])
  test(`799 HTTP conflicts preserve files and reset state (git=${git})`, async () => {
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
    const messageID = SessionMessage.ID.make(`msg_restore799_http_${git}`)
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

    const planResponse = await request(route + "/revert/plan/" + messageID)
    const plan = Schema.decodeUnknownSync(Schema.Struct({ data: Revert.Plan }))(await planResponse.json()).data
    expect(plan.files).toEqual(
      (git ? ["command.txt", "existing.txt", "new.txt"] : ["existing.txt", "new.txt"]).map((file) =>
        RelativePath.make(file),
      ),
    )
    const staged = await request(route + "/revert/stage", { messageID, planToken: plan.token })
    expect(staged.status, await staged.clone().text()).toBe(200)
    const resetContext = await messages()
    await Bun.write(path.join(tmp.path, "existing.txt"), "external-edit")
    const failures = []
    for (const action of ["clear", "stage"]) {
      const failed = await request(route + "/revert/" + action, action === "stage" ? { messageID } : undefined, "POST")
      const body = await failed.text()
      failures.push({ action, status: failed.status, body })
      expect(failed.status, body).toBe(500)
      expect(body).toContain("existing.txt")
      expect(body).toMatch(/changed|overwritten/)
      expect(await Bun.file(path.join(tmp.path, "existing.txt")).text()).toBe("external-edit")
      expect(await Bun.file(path.join(tmp.path, "new.txt")).exists()).toBe(false)
      expect(await messages()).toEqual(resetContext)
      const stateResponse = await request(route)
      expect(stateResponse.status).toBe(200)
      const current = Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(await stateResponse.json()).data
      expect(current.revert?.messageID).toBe(messageID)
    }
    // The user resolves the conflict by restoring the expected bytes, then retries.
    await Bun.write(path.join(tmp.path, "existing.txt"), "tool-before")
    expect((await request(route + "/revert/stage", { messageID })).status).toBe(200)
    expect((await request(route + "/revert/clear", undefined, "POST")).status).toBe(204)
    expect(await Bun.file(path.join(tmp.path, "existing.txt")).text()).toBe("tool-after")
    expect(await Bun.file(path.join(tmp.path, "new.txt")).text()).toBe("tool-created")
    expect(await Bun.file(path.join(tmp.path, "command.txt")).text()).toBe("cli-after")
    expect(await messages()).toEqual(original)
    expect(providerRequests).toBe(2)
    console.log("restore799-http: " + JSON.stringify({ git, failures, providerRequests, realModelRequests: 0 }))
  }, 120000)
