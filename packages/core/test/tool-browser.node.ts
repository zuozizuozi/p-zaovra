import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { access, mkdtemp, mkdir, rm, writeFile, copyFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
const expect = (value: unknown) => ({
  toBe: (other: unknown) => assert.equal(value, other),
  toEqual: (other: unknown) => assert.deepEqual(value, other),
  toContain: (other: string) => assert.ok(String(value).includes(other), String(value)),
  not: { toContain: (other: string) => assert.ok(!String(value).includes(other), String(value)) },
})
import { DateTime, Effect, Fiber, Layer } from "effect"
import { LLM } from "@zaovra-ai/llm"
import { OpenAIChat, OpenAIResponses } from "@zaovra-ai/llm/protocols"
import { Auth, LLMClient } from "@zaovra-ai/llm/route"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { SessionMessage } from "../src/session/message"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { BrowserTool } from "../src/tool/browser"
import { ToolRegistry } from "../src/tool/registry"
import { PermissionV2 } from "../src/permission"
import { Catalog } from "../src/catalog"
import { SessionStore } from "../src/session/store"
import { SessionSchema } from "../src/session/schema"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { Config } from "../src/config"
import { EventV2 } from "../src/event"
import { ToolOutputStore } from "../src/tool-output-store"
import { toolIdentity, settleTool } from "./lib/tool"

import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { LocationServiceMap } from "../src/location-service-map"
import { ProjectV2 } from "../src/project"

function browserProcesses(rootsOnly = true) {
  if (process.platform !== "win32") return []
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      (rootsOnly ? "" : "$rootsOnly=$false; ") +
        "$items=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('chrome.exe','headless_shell.exe','chrome-headless-shell.exe','msedge.exe') -and ($rootsOnly -eq $false -or $_.CommandLine -like '*--remote-debugging-pipe*') -and $_.CommandLine.Replace([char]92,[char]47) -like ('*'+$env:TEMP.Replace([char]92,[char]47)+'*') } | Select-Object ProcessId); ConvertTo-Json -Compress -InputObject $items",
    ],
    { encoding: "utf8" },
  )
  return (JSON.parse(output) as { ProcessId: number }[]).map((item) => item.ProcessId)
}

test(
  "browser observes, operates, retains screenshots, isolates sessions and closes on idle",
  { timeout: 60000 },
  async () => {
    const tmp = { path: await mkdtemp(path.join(os.tmpdir(), "browser-test-")) }
    let outsideHits = 0
    let uncertainHits = 0
    let effectHits = 0
    let webSocketHits = 0
    let batchHits = 0
    let batchKeys = 0
    const outside = createServer((_request, response) => {
      outsideHits++
      response.end("outside")
    })
    outside.on("upgrade", (_request, socket) => {
      webSocketHits++
      socket.destroy()
    })
    await new Promise<void>((resolve) => outside.listen(0, "127.0.0.1", resolve))
    const outsideAddress = outside.address()
    if (!outsideAddress || typeof outsideAddress === "string") throw Error("No outside server")
    const outsideURL = `http://127.0.0.1:${outsideAddress.port}`
    const server = createServer((request, response) => {
      if (request.url === "/batch-hit" || request.url === "/batch-key") {
        if (request.url === "/batch-hit") batchHits++
        if (request.url === "/batch-key") batchKeys++
        response.end("ok")
        return
      }
      if (request.url === "/batch") {
        response.setHeader("Content-Type", "text/html")
        response.end(
          `<title>Batch fixture</title><input type="search" aria-label="Search"><button onclick="fetch('/batch-hit');document.querySelector('p').textContent=document.querySelector('input').value">Save</button><p>empty</p><script>onkeydown=(e)=>{if(e.key==='ArrowRight')fetch('/batch-key')}</script>`,
        )
        return
      }
      if (request.url === "/effect") {
        effectHits++
        response.end("ok")
        return
      }
      if (request.url === "/stall") return
      if (request.url === "/file") {
        response.setHeader("Content-Disposition", 'attachment; filename="denied.txt"')
        response.end("must not be downloaded")
        return
      }
      if (request.url === "/behaviors") {
        response.setHeader("Content-Type", "text/html")
        response.end(
          `<!doctype html><title>Boundaries</title><button onclick="window.open('${outsideURL}/popup')">Popup</button><a href="/file" download>Download</a><button onclick="new WebSocket('${outsideURL.replace("http:", "ws:")}/socket')">Socket</button><button onclick="fetch('/effect');location.href='/stall'">Timeout</button><button onclick="for(let i=0;i<150;i++)console.log('entry'+i+':'+ 'x'.repeat(2000));document.querySelector('p').textContent='z'.repeat(40000)">Flood</button><p>ready</p>`,
        )
        return
      }
      if (request.url === "/uncertain") {
        uncertainHits++
        response.destroy()
        return
      }
      if (request.url === "/redirect") {
        response.writeHead(302, { location: outsideURL })
        response.end()
        return
      }
      response.setHeader("Content-Type", "text/html")
      response.end(
        `<!doctype html><title>Browser fixture</title><label>Name<input type="search" aria-label="Name"></label><button onclick="this.textContent='Saved'">Save</button><button>Duplicate</button><button>Duplicate</button><label>Upload<input type="file"></label><p id="counter">0</p><canvas id="board" width="320" height="120" aria-label="Keyboard canvas"></canvas><img src="${outsideURL}/image"><script>let down=false,n=0;onkeydown=()=>down=true;onkeyup=()=>down=false;setInterval(()=>{if(down){counter.textContent=String(++n);const c=board.getContext("2d");c.fillStyle="#e0e7ff";c.fillRect(0,0,320,120);c.fillStyle="#4f46e5";c.fillRect(n*4,40,24,24)}},20);console.log('fixture ready')</script>`,
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw Error("No server")
    const url = new URL(`http://127.0.0.1:${address.port}`)
    const assertions: PermissionV2.AssertInput[] = []
    const progress: unknown[] = []
    let denied = false
    let known = false
    let vision = false
    const model = ModelV2.Info.make({
      id: ModelV2.ID.make("fixture"),
      providerID: ProviderV2.ID.make("fixture"),
      name: "Fixture",
      api: { type: "native", id: ModelV2.ID.make("fixture"), settings: {} },
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      request: { headers: {}, body: {} },
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 1000, output: 1000 },
    })
    const layer = AppNodeBuilder.build(LayerNode.group([BrowserTool.node, ToolRegistry.node, ToolRegistry.toolsNode]), [
      [
        EventV2.node,
        Layer.mock(EventV2.Service, {
          recentAfter: () => ({ events: [], complete: false }),
          publish: (definition, data) =>
            Effect.sync(() => {
              progress.push(data)
              return { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
            }),
        }),
      ],
      [
        PermissionV2.node,
        Layer.mock(PermissionV2.Service, {
          assert: (input) =>
            denied
              ? Effect.fail(new PermissionV2.BlockedError({ rules: [] }))
              : Effect.sync(() => {
                  assertions.push(input)
                }),
        }),
      ],
      [
        Catalog.node,
        Layer.mock(Catalog.Service, {
          model: {
            get: (_provider, id) =>
              Effect.succeed(
                known && id === model.id
                  ? ModelV2.Info.make({
                      ...model,
                      capabilities: { ...model.capabilities, input: vision ? ["text", "image"] : ["text"] },
                    })
                  : undefined,
              ),
            all: () => Effect.succeed([]),
            available: () => Effect.succeed([]),
            default: () => Effect.succeed(undefined),
            small: () => Effect.succeed(undefined),
          },
          provider: {
            get: () => Effect.succeed(undefined),
            all: () => Effect.succeed([]),
            available: () => Effect.succeed([]),
          },
        }),
      ],
      [
        SessionStore.node,
        Layer.mock(SessionStore.Service, {
          message: () =>
            Effect.succeed({
              sessionID: SessionSchema.ID.make("ses_browser_a"),
              message: SessionMessage.Assistant.make({
                id: toolIdentity.assistantMessageID,
                type: "assistant",
                agent: "build",
                model: { providerID: model.providerID, id: ModelV2.ID.make("api-alias") },
                content: [],
                time: { created: DateTime.nowUnsafe() },
              }),
            }),
        }),
      ],
      [Global.node, Global.layerWith({ data: tmp.path })],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make(tmp.path) })],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ])
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const definitions = (yield* registry.materialize()).definitions
          const actions = [
            "open",
            "click",
            "type",
            "press",
            "scroll",
            "click_position",
            "snapshot",
            "screenshot",
            "console",
            "close",
            "batch",
          ]
          const responses = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
            LLM.request({
              model: OpenAIResponses.route
                .with({ endpoint: { baseURL: "https://example.test/v1" }, auth: Auth.bearer("test") })
                .model({ id: "test" }),
              prompt: "test",
              tools: definitions,
            }),
          )
          const chat = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
            LLM.request({
              model: OpenAIChat.route
                .with({ endpoint: { baseURL: "https://example.test/v1" }, auth: Auth.bearer("test") })
                .model({ id: "test" }),
              prompt: "test",
              tools: definitions,
            }),
          )
          for (const schema of [
            JSON.parse(JSON.stringify(responses.body)).tools[0].parameters,
            JSON.parse(JSON.stringify(chat.body)).tools[0].function.parameters,
          ]) {
            expect(schema.properties.action.enum).toEqual(actions)
            expect(schema.required).toEqual(["action"])
          }
          const browser = yield* BrowserTool.Service
          let calls = 0
          const call = (input: unknown, session = "ses_browser_a") =>
            settleTool(registry, {
              ...toolIdentity,
              sessionID: SessionSchema.ID.make(session),
              inputModalities: known ? (vision ? ["text", "image"] : ["text"]) : undefined,
              call: { type: "tool-call", id: `call_${++calls}`, name: "browser", input },
            })
          const missing = yield* call({ action: "snapshot" })
          expect(JSON.stringify(missing)).toContain("no active browser")
          const sequence = [
            { action: "type", target: { role: "searchbox", name: "Search" }, text: "batch value" },
            { action: "press", key: "Tab" },
            { action: "click", target: { role: "button", name: "Save" } },
            { action: "scroll", x: 0, y: 10 },
          ]
          yield* call({ action: "open", url: new URL("batch", url).href })
          const beforeSingle = calls
          for (const action of sequence) yield* call(action)
          const singleCalls = calls - beforeSingle
          const single = yield* call({ action: "snapshot" })
          expect(batchHits).toBe(1)
          yield* call({ action: "open", url: new URL("batch", url).href })
          const beforeBatch = calls
          const batch = yield* call({ action: "batch", actions: sequence })
          expect(calls - beforeBatch).toBe(1)
          expect(singleCalls).toBe(4)
          expect(batchHits).toBe(2)
          assert.deepEqual(
            (batch.output?.structured as { steps: unknown }).steps,
            sequence.map((action, index) => ({ index: index + 1, action: action.action, status: "executed" })),
          )
          const batchSnapshot = yield* call({ action: "snapshot" })
          expect(batchSnapshot.output?.structured).toEqual(single.output?.structured)
          const batchImage = yield* call({
            action: "batch",
            actions: [{ action: "scroll", x: 0, y: 0 }],
            observation: "screenshot",
          })
          assert.ok(
            (batchImage.output?.structured as { screenshot?: { name: string } }).screenshot?.name.endsWith(".png"),
          )
          expect((batchImage.output?.structured as { steps: { status: string }[] }).steps[0]?.status).toBe("executed")
          for (const observation of ["snapshot", "screenshot"]) {
            const trailing = yield* call({
              action: "batch",
              actions: [...Array(4).fill({ action: "scroll", x: 0, y: 0 }), { action: observation }],
            })
            expect(trailing.result.type).toBe("text")
            expect((trailing.output?.structured as { steps: unknown[] }).steps.length).toBe(4)
            if (observation === "screenshot")
              assert.ok((trailing.output?.structured as { screenshot?: unknown }).screenshot)
          }
          expect(
            (yield* call({
              action: "batch",
              actions: [{ action: "scroll", x: 0, y: 0 }, { action: "snapshot" }],
              observation: "screenshot",
            })).result.type,
          ).toBe("error")
          const click = { action: "click", target: { role: "button", name: "Save" } }
          const absent = yield* call({ action: "batch" })
          expect(absent.result.type).toBe("error")
          expect(JSON.stringify(absent)).toContain("Batch requires actions. Example:")
          for (const actions of [
            [click, { action: "press", key: "NotAKey" }],
            [click, { action: "open", url: url.href }],
            Array(5).fill(click),
            [],
            [{ action: "snapshot" }],
            [click, { action: "snapshot" }, click],
            [click, { action: "batch", actions: [click] }],
            [click, { action: "type", target: { selector: "[" }, text: "bad" }],
          ]) {
            expect((yield* call({ action: "batch", actions })).result.type).toBe("error")
            expect(batchHits).toBe(2)
          }
          denied = true
          const blocked = yield* call({ action: "batch", actions: [click, click] })
          expect(JSON.stringify(blocked)).toContain("not_executed")
          expect(batchHits).toBe(2)
          denied = false
          const failed = yield* call({
            action: "batch",
            actions: [click, { action: "click", target: { role: "button", name: "Missing" } }, click],
          })
          expect(failed.result.type).toBe("error")
          expect(batchHits).toBe(3)
          expect(
            (progress.at(-1) as { structured: { steps: { status: string }[] } }).structured.steps.map((x) => x.status),
          ).toEqual(["executed", "not_executed", "not_executed"])
          const previousKeys = batchKeys
          const cancel = yield* call({
            action: "batch",
            actions: [click, { action: "press", key: "ArrowRight", holdMs: 1500 }, click],
          }).pipe(Effect.forkChild)
          for (let i = 0; batchKeys === previousKeys && i < 100; i++) yield* Effect.sleep("20 millis")
          assert.ok(batchKeys > previousKeys, "wait for the held key to actually begin")
          yield* Fiber.interrupt(cancel)
          yield* Effect.sleep("100 millis")
          expect(batchHits).toBe(4)
          expect(
            (progress.at(-1) as { structured: { steps: { status: string }[] } }).structured.steps.map((x) => x.status),
          ).toEqual(["executed", "outcome_unknown", "not_executed"])
          expect(JSON.stringify(yield* call({ action: "open", url: "file:///etc/passwd" }))).toContain("Not executed")
          denied = true
          expect(JSON.stringify(yield* call({ action: "open", url: url.href }))).toContain("permission denied")
          denied = false
          const opened = yield* call({ action: "open", url: url.href })
          expect(JSON.stringify(opened)).toContain("Browser fixture")
          const invalidKey = yield* call({ action: "press", key: "NotAKey" })
          expect(JSON.stringify(invalidKey)).toContain("Not executed")
          expect(JSON.stringify(invalidKey)).not.toContain("Outcome may have occurred")
          expect((yield* call({ action: "press", key: "CTRL+a" })).result.type).toBe("text")
          expect(assertions.at(-1)?.resources).toEqual([url.origin])
          expect(outsideHits).toBe(0)
          expect(JSON.stringify(yield* call({ action: "open", url: new URL("uncertain", url).href }))).toContain(
            "Outcome may have occurred",
          )
          expect(uncertainHits).toBe(1)
          yield* call({ action: "open", url: url.href })
          expect(JSON.stringify(yield* call({ action: "click", target: { label: "Upload" } }))).toContain(
            "File upload is not supported",
          )
          expect(
            JSON.stringify(yield* call({ action: "click", target: { role: "button", name: "Duplicate" } })),
          ).toContain("matched 2")
          expect(
            JSON.stringify(yield* call({ action: "type", target: { role: "searchbox", name: "Name" }, text: "Hello" })),
          ).toContain("Hello")
          expect(JSON.stringify(yield* call({ action: "click", target: { role: "button", name: "Save" } }))).toContain(
            "Saved",
          )
          const held = yield* call({ action: "press", key: "ArrowRight", holdMs: 150 })
          assert.match((held.output?.structured as { text: string }).text, /paragraph: "?[1-9]\d*/)
          const after = yield* call({ action: "snapshot" })
          yield* Effect.sleep("100 millis")
          expect((yield* call({ action: "snapshot" })).output?.structured).toEqual(after.output?.structured)
          const shot = yield* call({ action: "screenshot" })
          expect(shot.output?.content.some((part) => part.type === "file")).toBe(false)
          expect(JSON.stringify(shot.output?.content)).toContain("model has not viewed")
          const structured = shot.output?.structured as { screenshot: { name: string; mime: string } }
          assert.equal("data" in structured.screenshot, false)
          assert.ok(JSON.stringify(structured).length < 10000)
          expect(structured.screenshot.name.endsWith(".png")).toBe(true)
          expect(yield* Effect.promise(() => access(structured.screenshot.name).then(() => true))).toBe(true)
          expect(structured.screenshot.mime).toBe("image/png")
          if (process.env.BROWSER_TEST_ARTIFACTS) {
            yield* Effect.promise(() =>
              copyFile(
                structured.screenshot.name,
                path.join(process.env.BROWSER_TEST_ARTIFACTS!, "browser-fixture.png"),
              ),
            )
          }
          known = true
          expect((yield* call({ action: "screenshot" })).output?.content.some((part) => part.type === "file")).toBe(
            false,
          )
          vision = true
          expect((yield* call({ action: "screenshot" })).output?.content.some((part) => part.type === "file")).toBe(
            true,
          )
          const redirected = yield* call({ action: "open", url: new URL("redirect", url).href })
          expect(JSON.stringify(redirected)).toContain("Redirect blocked")
          expect(outsideHits).toBe(0)
          expect(JSON.stringify(yield* call({ action: "open", url: url.href }, "ses_browser_b"))).not.toContain("Saved")
          yield* browser.close(SessionSchema.ID.make("ses_browser_a"))
          expect(JSON.stringify(yield* call({ action: "snapshot" }))).toContain("no active browser")
          expect(JSON.stringify(yield* call({ action: "snapshot" }, "ses_browser_b"))).toContain("Browser fixture")
          yield* Effect.sleep("600 millis")
          expect(JSON.stringify(yield* call({ action: "snapshot" }, "ses_browser_b"))).toContain("no active browser")
          yield* call({ action: "open", url: new URL("behaviors", url).href })
          const popped = yield* call({ action: "click", target: { role: "button", name: "Popup" } })
          yield* Effect.sleep("100 millis")
          const popup = yield* call({ action: "console" })
          expect(JSON.stringify(popped) + JSON.stringify(popup)).toContain("Popup blocked")
          // Events can arrive in the action observation or the following console read.
          expect(outsideHits).toBe(0)
          const download = yield* call({ action: "click", target: { role: "link", name: "Download" } })
          yield* Effect.sleep("100 millis")
          expect(JSON.stringify(download) + JSON.stringify(yield* call({ action: "console" }))).toContain(
            "Download blocked",
          )
          const socket = yield* call({ action: "click", target: { role: "button", name: "Socket" } })
          yield* Effect.sleep("100 millis")
          expect(JSON.stringify(socket) + JSON.stringify(yield* call({ action: "console" }))).toContain(
            "Blocked WebSocket origin",
          )
          expect(webSocketHits).toBe(0)
          const flood = yield* call({ action: "click", target: { role: "button", name: "Flood" } })
          expect(JSON.stringify(flood)).toContain("Observation truncated")
          expect(JSON.stringify(flood)).toContain("Earlier logs dropped")
          assert.ok((flood.outputPaths?.length ?? 0) > 0)
          assert.ok(Buffer.byteLength(JSON.stringify(flood.output?.content)) < 52000)
          expect(
            JSON.stringify(
              yield* call({
                action: "batch",
                actions: [
                  { action: "click", target: { role: "button", name: "Timeout" } },
                  { action: "click", target: { role: "button", name: "Timeout" } },
                ],
              }),
            ),
          ).toContain("Outcome may have occurred")
          expect(effectHits).toBe(1)
          expect(
            (progress.at(-1) as { structured: { steps: { status: string }[] } }).structured.steps.map((x) => x.status),
          ).toEqual(["outcome_unknown", "not_executed"])
          yield* call({ action: "close" })
          yield* call({ action: "open", url: url.href })
          const pressing = yield* call({ action: "press", key: "ArrowRight", holdMs: 3000 }).pipe(Effect.forkChild)
          yield* Effect.sleep("100 millis")
          yield* Fiber.interrupt(pressing)
          expect(JSON.stringify(yield* call({ action: "snapshot" }))).toContain("no active browser")
          yield* call({ action: "open", url: url.href })
          // A cancelled operation must not install a timer on this replacement owner.
          for (let index = 0; index < 6; index++) {
            yield* Effect.sleep("200 millis")
            expect(JSON.stringify(yield* call({ action: "snapshot" }))).toContain("Browser fixture")
          }
          expect(batchHits).toBe(4)
        }).pipe(Effect.provide(layer), Effect.provideService(BrowserTool.IdleTimeout, 500)),
      )
    } finally {
      server.closeAllConnections()
      server.close()
      outside.closeAllConnections()
      outside.close()
      await rm(tmp.path, { recursive: true, force: true })
    }
  },
)

test("real Session Stop, archive, Location disposal and browser process loss", { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-lifecycle-"))
  const second = path.join(root, "other")
  await mkdir(second)
  const initial = browserProcesses()
  const initialTree = browserProcesses(false)
  const server = createServer((_request, response) => response.end("<title>Lifecycle</title><p>alive</p>"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw Error("No server")
  const url = `http://127.0.0.1:${address.port}`
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const locations = yield* LocationServiceMap.Service
        const a = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(root) }) })
        const b = yield* sessions.create({ location: a.location })
        const c = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(second) }) })
        let sequence = 0
        const call = (session: SessionSchema.Info, input: unknown) =>
          ToolRegistry.Service.pipe(
            Effect.flatMap((registry) =>
              settleTool(registry, {
                ...toolIdentity,
                sessionID: session.id,
                call: { type: "tool-call", id: `life_${++sequence}`, name: "browser", input },
              }),
            ),
            Effect.provide(locations.get(session.location)),
          )
        const observe = (session: SessionSchema.Info) =>
          call(session, { action: "snapshot" }).pipe(Effect.map((value) => JSON.stringify(value)))
        for (const session of [a, b, c])
          expect(JSON.stringify(yield* call(session, { action: "open", url }))).toContain("Lifecycle")
        yield* sessions.interrupt(a.id)
        expect(yield* observe(a)).toContain("no active browser")
        expect(yield* observe(b)).toContain("Lifecycle")
        expect(yield* observe(c)).toContain("Lifecycle")
        yield* sessions.update({ sessionID: b.id, archived: true })
        expect(yield* observe(b)).toContain("no active browser")
        expect(yield* observe(c)).toContain("Lifecycle")
        yield* call(a, { action: "open", url })
        yield* locations.invalidate(a.location)
        expect(yield* observe(a)).toContain("no active browser")
        expect(yield* observe(c)).toContain("Lifecycle")
        if (process.platform === "win32") {
          const owned = browserProcesses().filter((pid) => !initial.includes(pid))
          assert.equal(owned.length, 1, "only the isolated survivor's browser is running")
          process.kill(owned[0]!)
          yield* Effect.sleep("300 millis")
          expect(yield* observe(c)).toContain("no active browser")
          expect(browserProcesses().filter((pid) => !initial.includes(pid)).length).toBe(0)
        }
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([SessionV2.node, LocationServiceMap.node]), [
            [SessionExecution.node, SessionExecution.noopLayer],
            [Global.node, Global.layerWith({ data: root })],
            [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
            [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
            [
              ProjectV2.node,
              Layer.mock(ProjectV2.Service, {
                resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
                directories: () => Effect.succeed([]),
                commit: () => Effect.void,
              }),
            ],
          ]),
        ),
      ),
    )
    assert.deepEqual(browserProcesses(false), initialTree, "scope release leaves no owned browser or child process")
  } finally {
    server.closeAllConnections()
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})
