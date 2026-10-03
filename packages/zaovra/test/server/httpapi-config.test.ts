import { ConfigParse } from "../../src/config/parse"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it, pollWithTimeout } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"
import { Global } from "@zaovra-ai/core/global"

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.live(
    "reports invalid global config and recovers after a correcting patch",
    Effect.gen(function* () {
      const file = Bun.file(path.join(Global.Path.config, "zaovra.jsonc"))
      const before = yield* Effect.promise(async () => ((await file.exists()) ? await file.text() : undefined))
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await (before === undefined ? file.delete() : Bun.write(file, before))
        }),
      )
      yield* Effect.promise(() => Bun.write(file, JSON.stringify({ username: 42 })))
      const invalid = yield* Effect.promise(() => Promise.resolve(app().request("/global/config")))
      expect(invalid.status).toBe(400)
      const repaired = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/global/config", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "repaired" }),
          }),
        ),
      )
      expect(repaired.status).toBe(200)
      const read = yield* Effect.promise(() => Promise.resolve(app().request("/global/config")))
      expect(read.status).toBe(200)
      expect(yield* Effect.promise(() => read.json())).toMatchObject({ username: "repaired" })
    }),
  )
  ;["jsonc", "json"].forEach((extension) =>
    it.live(
      `preserves native global ${extension} configuration when updating a desktop preference`,
      Effect.gen(function* () {
        // Other suites may initialize the higher-priority JSONC file. This case
        // specifically exercises writing JSON when it is the active config file.
        if (extension === "json") {
          const jsonc = Bun.file(path.join(Global.Path.config, "zaovra.jsonc"))
          const saved = yield* Effect.promise(async () => ((await jsonc.exists()) ? await jsonc.text() : undefined))
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              if (saved !== undefined) await Bun.write(jsonc, saved)
              await app().request("/global/dispose", { method: "POST" })
            }),
          )
          if (saved !== undefined) yield* Effect.promise(() => jsonc.delete())
        }
        const file = Bun.file(path.join(Global.Path.config, `zaovra.${extension}`))
        const before = yield* Effect.promise(async () => ((await file.exists()) ? await file.text() : undefined))
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await (before === undefined ? file.delete() : Bun.write(file, before))
            await app().request("/global/dispose", { method: "POST" })
          }),
        )
        const native = {
          provider_filter: { allow: ["native"], deny: ["previous"] },
          providers: { native: { api: { type: "native", settings: { custom: "retained" } } } },
          permissions: [
            { action: "edit", resource: "*", effect: "deny" },
            { action: "edit", resource: "src/*", effect: "allow" },
          ],
          mcp: { servers: {} },
          skills: ["./team-skills"],
        }
        yield* Effect.promise(() => Bun.write(file, "// Keep native configuration\n" + JSON.stringify(native, null, 2)))
        const response = yield* Effect.promise(() =>
          Promise.resolve(
            app().request("/global/config", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ autoupdate: false, disabled_providers: ["native"] }),
            }),
          ),
        )
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toMatchObject({ autoupdate: false })
        const saved = yield* Effect.promise(() => Bun.file(file.name!).text())
        expect(saved).toContain("// Keep native configuration")
        expect(JSON.parse(saved.slice(saved.indexOf("{")))).toEqual({
          ...native,
          provider_filter: { allow: ["native"], deny: ["native"] },
          autoupdate: false,
          disabled_providers: ["native"],
        })
        const preferences = yield* Effect.promise(() => Promise.resolve(app().request("/global/config")))
        expect(preferences.status).toBe(200)
        expect(yield* Effect.promise(() => preferences.json())).toMatchObject({ autoupdate: false })
      }),
    ),
  )

  it.live(
    "repairs invalid config without bootstrapping it before the write",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, "zaovra.json"),
          JSON.stringify({
            username: 42,
            formatter: false,
            lsp: false,
          }),
        ),
      )
      const headers = { "x-zaovra-directory": tmp.path, "content-type": "application/json" }
      const invalid = yield* Effect.promise(() => Promise.resolve(app().request("/config", { headers })))
      expect(invalid.status).toBe(400)
      const invalidRuntime = yield* Effect.promise(() => Promise.resolve(app().request("/api/provider", { headers })))
      expect(invalidRuntime.status).toBe(400)
      const saved = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers,
            body: JSON.stringify({ username: "repaired" }),
          }),
        ),
      )
      expect(saved.status).toBe(200)
      const restored = yield* Effect.promise(() => Promise.resolve(app().request("/config", { headers })))
      expect(restored.status).toBe(200)
      expect(yield* Effect.promise(() => restored.json())).toMatchObject({ username: "repaired" })
      const runtime = yield* Effect.promise(() => Promise.resolve(app().request("/api/provider", { headers })))
      expect(runtime.status).toBe(200)
    }),
  )

  it.live(
    "does not hide unknown settings behind the native preferences view",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, "zaovra.json"),
          JSON.stringify({
            providers: {},
            unexpected_setting: true,
          }),
        ),
      )
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: { "x-zaovra-directory": tmp.path },
          }),
        ),
      )
      expect(response.status).toBe(400)
    }),
  )

  it.live(
    "preserves inherited allow filters when a later document only changes deny",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, "zaovra.json"),
          JSON.stringify({
            provider_filter: { allow: ["one", "two"] },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, "zaovra.jsonc"),
          JSON.stringify({
            provider_filter: { deny: ["two"] },
          }),
        ),
      )
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: { "x-zaovra-directory": tmp.path },
          }),
        ),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        enabled_providers: ["one", "two"],
        disabled_providers: ["two"],
      })
    }),
  )

  it.live(
    "keeps V2 provider definitions when desktop legacy settings share their file",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, "zaovra.json"),
          JSON.stringify({
            disabled_providers: ["legacy"],
            provider_filter: { deny: ["legacy"] },
            model: "mixed/chat",
            shell: "audit-shell",
            providers: {
              mixed: {
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: "http://127.0.0.1:1/v1",
                  settings: { apiKey: "fixture" },
                },
                models: { chat: { limit: { context: 1000, output: 100 } } },
              },
            },
            mcp: { servers: {} },
            skills: [],
          }),
        ),
      )
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/api/provider", {
            headers: { "x-zaovra-directory": tmp.path },
          }),
        ),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        data: expect.arrayContaining([
          expect.objectContaining({ id: "mixed", api: expect.objectContaining({ type: "aisdk" }) }),
        ]),
      })
      const before = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "zaovra.json")).json())
      const preferences = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: { "x-zaovra-directory": tmp.path },
          }),
        ),
      )
      expect(preferences.status).toBe(200)
      expect(yield* Effect.promise(() => preferences.json())).toMatchObject({
        model: "mixed/chat",
        shell: "audit-shell",
        disabled_providers: ["legacy"],
      })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
      const saved = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: { "x-zaovra-directory": tmp.path, "content-type": "application/json" },
            body: JSON.stringify({ username: "mixed-saved", disabled_providers: ["mixed"] }),
          }),
        ),
      )
      expect(saved.status).toBe(200)
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "zaovra.json")).json())).toEqual({
        ...before,
        username: "mixed-saved",
        disabled_providers: ["mixed"],
        provider_filter: { deny: ["mixed"] },
      })
      const after = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/api/provider", {
            headers: { "x-zaovra-directory": tmp.path },
          }),
        ),
      )
      expect(after.status).toBe(200)
      expect(yield* Effect.promise(() => after.json())).toMatchObject({
        data: expect.not.arrayContaining([expect.objectContaining({ id: "mixed" })]),
      })
    }),
  )

  it.live(
    "desktop provider disabling refreshes the already-open V2 model catalog",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        git: true,
        config: {
          formatter: false,
          lsp: false,
          provider: {
            "audit-disable": {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "fixture" },
              models: { chat: { limit: { context: 1000, output: 100 } } },
            },
          },
        },
      })
      const headers = { "content-type": "application/json", "x-zaovra-directory": tmp.path }
      const before = yield* Effect.promise(() => Promise.resolve(app().request("/api/provider", { headers })))
      expect(before.status).toBe(200)
      expect(yield* Effect.promise(() => before.json())).toMatchObject({
        data: expect.arrayContaining([expect.objectContaining({ id: "audit-disable" })]),
      })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
      const update = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers,
            body: JSON.stringify({ disabled_providers: ["audit-disable"] }),
          }),
        ),
      )
      expect(update.status).toBe(200)
      yield* Fiber.join(disposed)
      const after = yield* Effect.promise(() => Promise.resolve(app().request("/api/provider", { headers })))
      expect(after.status).toBe(200)
      expect(yield* Effect.promise(() => after.json())).toMatchObject({
        data: expect.not.arrayContaining([expect.objectContaining({ id: "audit-disable" })]),
      })
    }),
  )

  it.live(
    "updates the higher-priority JSONC file without removing comments or unrelated settings",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true, config: { username: "json-user", formatter: false, lsp: false } })
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, "zaovra.jsonc"),
          '{\n  // Keep this project note\n  "username": "jsonc-user",\n  "share": "disabled"\n}\n',
        ),
      )
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: { "content-type": "application/json", "x-zaovra-directory": tmp.path },
            body: JSON.stringify({ username: "updated-user" }),
          }),
        ),
      )
      expect(response.status).toBe(200)
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "zaovra.jsonc")).text())).toContain(
        "// Keep this project note",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "zaovra.json")).json())).toMatchObject({
        username: "json-user",
      })
      const reloaded = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config", { headers: { "x-zaovra-directory": tmp.path } })),
      )
      expect(reloaded.status).toBe(200)
      expect(yield* Effect.promise(() => reloaded.json())).toMatchObject({
        username: "updated-user",
        share: "disabled",
        formatter: false,
        lsp: false,
      })
    }),
  )

  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true, config: { formatter: false, lsp: false } })
      const opened = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: { "x-zaovra-directory": tmp.path },
          }),
        ),
      )
      expect(opened.status).toBe(200)
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-zaovra-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "zaovra.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      const reloaded = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: { "x-zaovra-directory": tmp.path },
          }),
        ),
      )
      expect(reloaded.status).toBe(200)
      expect(yield* Effect.promise(() => reloaded.json())).toMatchObject({ username: "patched-user" })
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-zaovra-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )
})

it.live(
  "clears only the model npm override when desktop restores provider inheritance",
  Effect.gen(function* () {
    const file = Bun.file(path.join(Global.Path.config, "zaovra.jsonc"))
    const before = yield* Effect.promise(async () => ((await file.exists()) ? await file.text() : undefined))
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await (before === undefined ? file.delete() : Bun.write(file, before))
        await app().request("/global/dispose", { method: "POST" })
      }),
    )
    const provider = {
      npm: "@ai-sdk/openai-compatible",
      name: "Fixture",
      options: { baseURL: "http://127.0.0.1:1/gateway/v1", headers: { "x-local": "retained" } },
      whitelist: ["one"],
      models: {
        one: {
          provider: { npm: "@ai-sdk/openai", api: "http://127.0.0.1:1/model" },
          options: { reasoningEffort: "low" },
          variants: { high: { reasoningEffort: "high" } },
        },
      },
    }
    yield* Effect.promise(() => Bun.write(file, JSON.stringify({ provider: { fixture: provider } })))
    const update = yield* Effect.promise(() =>
      Promise.resolve(
        app().request("/global/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: { fixture: { models: { one: { provider: { npm: "" } } } } } }),
        }),
      ),
    )
    expect(update.status).toBe(200)
    const stored = yield* Effect.promise(async () =>
      JSON.parse(JSON.stringify(ConfigParse.jsonc(await Bun.file(file.name!).text(), file.name!))),
    )
    expect(stored.provider.fixture.models.one.provider).toEqual({ api: "http://127.0.0.1:1/model" })
    expect(stored.provider.fixture.options).toEqual(provider.options)
    expect(stored.provider.fixture.models.one.options).toEqual(provider.models.one.options)
    expect(stored.provider.fixture.models.one.variants).toEqual(provider.models.one.variants)
    expect(stored.provider.fixture.whitelist).toEqual(provider.whitelist)
    const read = yield* Effect.promise(() => Promise.resolve(app().request("/global/config")))
    expect(read.status).toBe(200)
    const result = yield* Effect.promise(() => read.json())
    expect(result.provider.fixture.models.one.provider).not.toHaveProperty("npm")
  }),
)

it.live(
  "saved model protocol changes the next drain without interrupting the active drain",
  Effect.gen(function* () {
    const tmp = yield* tmpdirEffect({ git: true })
    yield* Effect.promise(() => Bun.write(path.join(tmp.path, "fixture.txt"), "protocol fixture content"))
    const file = Bun.file(path.join(Global.Path.config, "zaovra.jsonc"))
    const before = yield* Effect.promise(async () => ((await file.exists()) ? await file.text() : undefined))
    const gate = Promise.withResolvers<void>()
    const urls: string[] = []
    const bodies: Record<string, unknown>[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        urls.push(request.url)
        bodies.push((await request.json()) as Record<string, unknown>)
        if (urls.length === 1) await gate.promise
        const response = request.url.endsWith("/responses")
        const call = {
          type: "function_call",
          id: "fc1",
          call_id: "call1",
          name: "read",
          arguments: JSON.stringify({ path: "fixture.txt" }),
        }
        const events = !response
          ? [
              {
                id: "chat1",
                object: "chat.completion.chunk",
                created: 1,
                model: "fixture",
                choices: [{ index: 0, delta: { content: "First drain done." }, finish_reason: "stop" }],
              },
            ]
          : urls.length === 2
            ? [
                { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
                {
                  type: "response.function_call_arguments.delta",
                  item_id: "fc1",
                  output_index: 0,
                  delta: call.arguments,
                },
                { type: "response.output_item.done", output_index: 0, item: call },
                {
                  type: "response.completed",
                  response: {
                    id: "r1",
                    status: "completed",
                    output: [call],
                    usage: { input_tokens: 1, output_tokens: 1 },
                  },
                },
              ]
            : [
                {
                  type: "response.output_text.delta",
                  item_id: "m1",
                  output_index: 0,
                  content_index: 0,
                  delta: "Responses drain done.",
                },
                {
                  type: "response.completed",
                  response: { id: "r2", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
                },
              ]
        return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        gate.resolve()
        server.stop(true)
        await (before === undefined ? file.delete() : Bun.write(file, before))
        await app().request("/global/dispose", { method: "POST" })
      }),
    )
    const baseURL = `http://127.0.0.1:${server.port}/tenant/openai/v1`
    const api = async (url: string, payload?: unknown, method = "POST") => {
      const response = await app().request(
        url,
        payload === undefined
          ? undefined
          : {
              method,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            },
      )
      const text = await response.text()
      if (!response.ok) throw new Error(`${url}: ${response.status}: ${text}`)
      return text ? JSON.parse(text) : undefined
    }
    yield* Effect.promise(() =>
      api(
        "/global/config",
        {
          provider: {
            protocolfixture: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL, apiKey: "local-fixture" },
              models: {
                fixture: {
                  tool_call: true,
                  limit: { context: 200000, output: 4000 },
                  options: { reasoningEffort: "low" },
                },
              },
            },
          },
          permission: { "*": "allow" },
          snapshot: false,
          lsp: false,
          formatter: false,
        },
        "PATCH",
      ),
    )
    const created = yield* Effect.promise(() =>
      api("/api/session", {
        location: { directory: tmp.path },
        model: { providerID: "protocolfixture", id: "fixture" },
        agent: "build",
      }),
    )
    const id: string = created.data.id
    yield* Effect.promise(() => api(`/api/session/${id}/prompt`, { prompt: { text: "Reply briefly." } }))
    yield* pollWithTimeout(
      Effect.sync(() => (urls.length === 1 ? true : undefined)),
      "first Chat request did not start",
      "20 seconds",
    )
    yield* Effect.promise(() =>
      api(
        "/global/config",
        {
          provider: {
            protocolfixture: {
              models: { fixture: { provider: { npm: "@ai-sdk/openai" } } },
            },
          },
        },
        "PATCH",
      ),
    )
    expect(urls).toEqual([`${baseURL}/chat/completions`])
    const active = yield* Effect.promise(() => api("/api/session/active"))
    expect(active.data[id]).toEqual({ type: "running" })
    gate.resolve()
    const idle = () =>
      pollWithTimeout(
        Effect.promise(async () => {
          const active = await api("/api/session/active")
          return active.data[id] === undefined ? true : undefined
        }),
        "drain did not finish",
        "20 seconds",
      )
    yield* idle()
    yield* Effect.promise(() => api(`/api/session/${id}/prompt`, { prompt: { text: "Read fixture.txt, then reply." } }))
    yield* pollWithTimeout(
      Effect.sync(() => (urls.length >= 3 ? true : undefined)),
      "Responses tool continuation did not happen",
      "20 seconds",
    )
    yield* idle()
    expect(urls).toEqual([`${baseURL}/chat/completions`, `${baseURL}/responses`, `${baseURL}/responses`])
    expect(bodies[1].reasoning).toMatchObject({ effort: "low" })
    expect(bodies[1].tools).toBeArray()
    expect(JSON.stringify(bodies[2].input)).toContain("protocol fixture content")
    const history = yield* Effect.promise(() => api(`/api/session/${id}/message`))
    expect(JSON.stringify(history)).toContain("Responses drain done.")
  }),
  60000,
)
