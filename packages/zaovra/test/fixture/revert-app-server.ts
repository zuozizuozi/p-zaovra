import fs from "node:fs/promises"
import path from "node:path"
import { Context, Schema } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { UI_UPSTREAM } from "../../src/server/shared/ui"

const [root, renderer, mode] = process.argv.slice(2)
if (!root || !renderer) throw new Error("Missing isolated profile and built renderer paths")
if (!(await Bun.file(path.join(renderer, "index.html")).exists())) throw new Error("Built renderer unavailable")
const resume = mode === "--resume"
if ((await Bun.file(path.join(root, "fixture-ready.json")).exists()) !== resume)
  throw new Error("Use a fresh profile, or explicitly resume an existing fixture")
await fs.mkdir(root, { recursive: true })
const projects = resume
  ? Schema.decodeUnknownSync(
      Schema.Struct({ projects: Schema.Array(Schema.Struct({ git: Schema.Boolean, directory: Schema.String })) }),
    )(await Bun.file(path.join(root, "fixture-ready.json")).json()).projects
  : await Promise.all(
      [false, true].map(async (git) => {
        const directory = path.join(root, git ? "git-project" : "nongit-project")
        await fs.mkdir(directory)
        await Bun.write(path.join(directory, "existing.txt"), "tool-before")
        await Bun.write(path.join(directory, "command.txt"), "cli-before")
        await Bun.write(
          path.join(directory, "zaovra.json"),
          JSON.stringify({
            formatter: false,
            lsp: false,
            permission: { "*": "allow" },
            provider: {
              "audit-revert": {
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: "http://127.0.0.1:4565/v1", apiKey: "fixture" },
                models: {
                  "audit-model": { name: "789 local scripted model", limit: { context: 128000, output: 1024 } },
                },
              },
            },
          }),
        )
        if (git) {
          for (const args of [
            ["init", "--quiet"],
            ["config", "core.fsmonitor", "false"],
            ["config", "commit.gpgsign", "false"],
            ["config", "user.name", "Fixture"],
            ["config", "user.email", "fixture@zaovra.test"],
            ["add", "."],
            ["commit", "--quiet", "-m", "isolated fixture"],
          ]) {
            const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
            const [code, stdout, stderr] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ])
            if (code) throw new Error(stdout + stderr)
          }
        }
        return { git, directory }
      }),
    )
if (projects.some((project) => !project.directory.startsWith(path.resolve(root) + path.sep)))
  throw new Error("Fixture project escaped its isolated root")
let providerRequests = resume
  ? Schema.decodeUnknownSync(Schema.Struct({ providerRequests: Schema.Number }))(
      await Bun.file(path.join(root, "provider-count.json")).json(),
    ).providerRequests
  : 0
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 4565,
  async fetch(request) {
    const body = Schema.decodeUnknownSync(
      Schema.Struct({
        messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
      }),
    )(await request.json())
    providerRequests++
    const last = body.messages.at(-1)
    const tools = last?.role === "user" && JSON.stringify(last.content).includes("789-create-files")
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
                  description: "Change command.txt inside isolated project",
                  timeout: 10000,
                }),
              },
            },
          ],
        }
      : { content: "789 fixture completed. Files were produced by actual tools." }
    console.log("local-provider:" + JSON.stringify({ request: providerRequests, tools }))
    await Bun.write(path.join(root, "provider-count.json"), JSON.stringify({ providerRequests }))
    return new Response(
      `data: ${JSON.stringify({ id: "revert-app", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "revert-app", choices: [{ index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const assets = Bun.serve({
  hostname: "127.0.0.1",
  port: 4566,
  async fetch(request) {
    const filename = path.resolve(renderer, "." + decodeURIComponent(new URL(request.url).pathname))
    if (!filename.startsWith(path.resolve(renderer) + path.sep))
      return new Response(Bun.file(path.join(renderer, "index.html")))
    const file = Bun.file(filename)
    return new Response((await file.exists()) ? file : Bun.file(path.join(renderer, "index.html")))
  },
})
const upstream = UI_UPSTREAM.href
UI_UPSTREAM.href = "http://127.0.0.1:4566"
const context = Context.empty() as Context.Context<unknown>
const handler = HttpApiApp.webHandler()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4563,
  idleTimeout: 0,
  fetch: (request) => handler.handler(request, context),
})
await Bun.write(
  path.join(root, "fixture-ready.json"),
  JSON.stringify({ pid: process.pid, ports: [4563, 4565, 4566], root, renderer, projects }),
)
console.log("fixture-ready:" + JSON.stringify({ pid: process.pid, ports: [4563, 4565, 4566], projects }))
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve)
  process.once("SIGTERM", resolve)
})
await server.stop(true)
await assets.stop(true)
await provider.stop(true)
UI_UPSTREAM.href = upstream
await handler.dispose()
console.log("fixture-closed:" + JSON.stringify({ pid: process.pid, providerRequests, ports: [4563, 4565, 4566] }))
