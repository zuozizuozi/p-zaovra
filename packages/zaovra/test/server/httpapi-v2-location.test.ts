import { afterEach, describe, expect, test } from "bun:test"
import { EventV2 } from "@zaovra-ai/core/event"
import { Location } from "@zaovra-ai/core/location"
import { Context, Schema } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import fs from "node:fs/promises"
import path from "node:path"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-zaovra-directory", encodeURIComponent(directory))
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const Event = Schema.Struct({
  id: EventV2.ID,
  type: Schema.String,
  location: Schema.optional(Location.Ref),
  data: Schema.Unknown,
})

async function* eventStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const boundary = buffer.match(/(?:\r\n|\r|\n){2}/)
      if (!boundary || boundary.index === undefined) {
        const value = await reader.read()
        if (value.done) return
        buffer += decoder.decode(value.value, { stream: true })
        continue
      }

      const record = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = record
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
      if (data.length) yield Schema.decodeUnknownSync(Event)(JSON.parse(data.join("\n")))
    }
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

async function readEvent(reader: AsyncIterator<typeof Event.Type>) {
  const value = await reader.next()
  if (value.done) throw new Error("event stream closed")
  return value.value
}

async function readEventType(reader: AsyncIterator<typeof Event.Type>, type: string) {
  for (let index = 0; index < 20; index++) {
    const event = await readEvent(reader)
    if (event.type === type) return event
  }
  throw new Error(`timed out waiting for ${type}`)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 location HttpApi", () => {
  test("490 HTTP host run policy rejects an unbound reserve and preserves explicit deadline without starting execution", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await request("/api/session", tmp.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: { directory: tmp.path } }),
    })
    expect(created.status).toBe(200)
    const session = (await created.json()).data
    const submit = (runPolicy: object) =>
      request(`/api/session/${session.id}/prompt`, tmp.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: { text: "Admit policy only; no model", runPolicy },
          delivery: "queue",
          resume: false,
        }),
      })
    const invalid = await submit({ mode: "unattended", closingReserveMs: 1000 })
    expect(invalid.status).toBe(400)
    const negative = await submit({ mode: "unattended", deadline: 0, closingReserveMs: -1 })
    expect(negative.status).toBe(400)
    const runPolicy = { mode: "unattended", deadline: 0, closingReserveMs: 0 }
    const admitted = await submit(runPolicy)
    expect(admitted.status).toBe(200)
    expect((await admitted.json()).data.prompt.runPolicy).toEqual(runPolicy)
    const pending = await request(`/api/session/${session.id}/input/pending`, tmp.path)
    const inputs = (await pending.json()).data
    expect(inputs).toHaveLength(1)
    expect(inputs[0].prompt.runPolicy).toEqual(runPolicy)
    expect((await (await request("/api/session/active", tmp.path)).json()).data).toEqual({})
  })

  test("490 HTTP creation and patches distinguish ordinary, autonomous and explicit durations without resuming", async () => {
    await using tmp = await tmpdir({ git: true })
    const create = async (selection: object) => {
      const response = await request("/api/session", tmp.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: { directory: tmp.path }, ...selection }),
      })
      expect(response.status).toBe(200)
      return (await response.json()).data
    }
    const limits = async (id: string) => {
      const response = await request(`/api/session/${id}/budget`, tmp.path)
      expect(response.status).toBe(200)
      return (await response.json()).data.limits
    }
    const ordinary = await create({})
    expect(await limits(ordinary.id)).toEqual({})
    const delegated = await create({ budgetMode: "autonomous" })
    expect(await limits(delegated.id)).toEqual({ tokens: 30_000_000, durationMs: 43_200_000 })
    const chosen = await create({ budgetMode: "autonomous", budget: { durationMs: 60_000 } })
    expect(await limits(chosen.id)).toEqual({ tokens: 30_000_000, durationMs: 60_000 })
    for (const budget of [{}, { durationMs: null }]) {
      const patched = await request(`/api/session/${chosen.id}`, tmp.path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budget }),
      })
      expect(patched.status).toBe(200)
      expect(await limits(chosen.id)).toEqual({
        tokens: 30_000_000,
        ...(Object.keys(budget).length ? {} : { durationMs: 60_000 }),
      })
    }
    const active = await request("/api/session/active", tmp.path)
    expect((await active.json()).data).toEqual({})
    for (const duration of [undefined, null, 900_000]) {
      const response = await request("/api/work", tmp.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: { directory: tmp.path },
          objective: "budget choice fixture",
          acceptanceCriteria: [{ description: "no model execution", required: true, evidence: "test" }],
          ...(duration === undefined ? {} : { budget: { maxDurationMs: duration } }),
        }),
      })
      expect(response.status).toBe(200)
      const goal = (await response.json()).data.goal
      expect(goal.budget.maxDurationMs).toBe(duration === undefined ? 43_200_000 : duration)
      expect(goal.status).toBe("draft")
    }
  })

  test("490 public approvals persist literal provenance despite forged tool metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "zaovra.json"), JSON.stringify({ permission: { bash: "ask" } }))
    const created = await request("/api/session", tmp.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: { directory: tmp.path } }),
    })
    expect(created.status).toBe(200)
    const session = (await created.json()).data
    const ask = async (command: string) => {
      const response = await request(`/api/session/${session.id}/permission`, tmp.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "bash",
          resources: [command],
          save: [command],
          saveMode: "pattern",
          origin: "internal",
          metadata: { saveMode: "pattern", origin: "internal" },
          source: { type: "tool", messageID: "forged", callID: "forged" },
        }),
      })
      expect(response.status).toBe(200)
      return (await response.json()).data
    }
    const approved = await ask("ls *.py")
    expect(approved.effect).toBe("ask")
    expect(
      (
        await request(`/api/session/${session.id}/permission/${approved.id}/reply`, tmp.path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reply: "always" }),
        })
      ).status,
    ).toBe(204)
    const saved = await request("/api/permission/saved", tmp.path)
    expect(saved.status).toBe(200)
    expect((await saved.json()).data).toMatchObject([
      {
        action: "bash",
        resource: "ls *.py",
        matchMode: "literal",
        origin: "api",
        version: 2,
      },
    ])
    expect((await ask("ls *.py")).effect).toBe("allow")
    expect((await ask("ls x.py; echo unexpected.py")).effect).toBe("ask")
  }, 30000)

  test("S1 default budgets, explicit unlimited and live session adjustments survive HTTP", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await request("/api/session", tmp.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: { directory: tmp.path } }),
    })
    expect(created.status).toBe(200)
    const session = (await created.json()).data
    const route = `/api/session/${session.id}/budget`
    const defaults = await request(route, tmp.path)
    expect(defaults.status).toBe(200)
    const defaultBudget = await defaults.json()
    expect(defaultBudget).toMatchObject({ data: { used: { tokens: 0 }, unreported: 0 } })
    expect(defaultBudget.data.limits).toEqual({ durationMs: 43_200_000 })
    const update = await request(`/api/session/${session.id}`, tmp.path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ budget: { tokens: 40_000_000, durationMs: 86_400_000 } }),
    })
    expect(update.status).toBe(200)
    expect(await (await request(route, tmp.path)).json()).toMatchObject({
      data: { limits: { tokens: 40_000_000, durationMs: 86_400_000 } },
    })
    expect(
      (
        await request(`/api/session/${session.id}`, tmp.path, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ budget: {} }),
        })
      ).status,
    ).toBe(200)
    expect((await (await request(route, tmp.path)).json()).data.limits).toEqual({
      tokens: 40_000_000,
      durationMs: 86_400_000,
    })
    for (const [budget, limits] of [
      [{ tokens: null }, { durationMs: 86_400_000 }],
      [{ durationMs: null }, {}],
    ]) {
      expect(
        (
          await request(`/api/session/${session.id}`, tmp.path, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ budget }),
          })
        ).status,
      ).toBe(200)
      expect((await (await request(route, tmp.path)).json()).data.limits).toEqual(limits)
    }
    expect((await request("/api/session/ses_missing_budget/budget", tmp.path)).status).toBe(404)
  }, 30000)

  test("isolates missing directories and reopens restored projects without restarting", async () => {
    await using tmp = await tmpdir({ git: true })
    const directory = path.join(tmp.path, "missing-project")
    const route = `/api/location?location[directory]=${encodeURIComponent(directory)}`
    const missing = await request(route, tmp.path)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ name: "DirectoryUnavailableError", data: { directory } })
    expect(await fs.stat(directory).catch(() => undefined)).toBeUndefined()
    expect((await request("/api/agent", tmp.path)).status).toBe(200)
    // Legacy bootstrap requests bypass the V2 directory gate; they must not
    // poison the shared service graph while the directory is still missing.
    await request(`/lsp`, directory)

    await fs.mkdir(directory)
    expect((await request(route, tmp.path)).status).toBe(200)
    const created = await request("/api/session", directory, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: { directory } }),
    })
    expect(created.status).toBe(200)
    const session = (await created.json()).data
    await fs.rename(directory, `${directory}-moved`)
    expect((await request(route, tmp.path)).status).toBe(404)
    expect((await request("/api/agent", tmp.path)).status).toBe(200)
    await fs.rename(`${directory}-moved`, directory)
    expect((await request(route, tmp.path)).status).toBe(200)
    const restored = await request(`/api/session/${session.id}`, directory)
    expect(restored.status).toBe(200)
    expect((await restored.json()).data.id).toBe(session.id)
  }, 30000)

  test("does not label configuration errors as missing directories", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "zaovra.json"), "{ invalid json")
    const response = await request("/api/location", tmp.path)
    expect(response.status).toBe(400)
    expect((await response.json()).name).not.toBe("DirectoryUnavailableError")
  }, 30000)

  test("lists only configured models supported by the V2 runner", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (directory) =>
        Bun.write(
          `${directory}/zaovra.json`,
          JSON.stringify({
            providers: Object.fromEntries(
              [
                ["audit-azure", "@ai-sdk/azure"],
                ["audit-compatible", "@ai-sdk/openai-compatible"],
                ["audit-openrouter", "@openrouter/ai-sdk-provider"],
              ].map(([id, npm]) => [
                id,
                {
                  api: { type: "aisdk", package: npm, url: "http://127.0.0.1:1/v1" },
                  request: { body: { apiKey: "audit-only" } },
                  models: { "audit-model": { name: "Audit model", disabled: false } },
                },
              ]),
            ),
          }),
        ),
    })
    // These are issued together by the model picker on a cold Location.
    const [listed, providers, integrations, agents] = await Promise.all(
      ["/api/model", "/api/provider", "/api/integration", "/api/agent"].map((route) => request(route, tmp.path)),
    )
    expect(listed.status).toBe(200)
    expect(providers.status).toBe(200)
    expect(integrations.status).toBe(200)
    expect(agents.status).toBe(200)
    expect((await providers.json()).data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "audit-compatible" })]),
    )
    expect((await integrations.json()).data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "audit-compatible" })]),
    )
    expect((await agents.json()).data).toEqual(expect.arrayContaining([expect.objectContaining({ id: "build" })]))
    const body = await listed.json()
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerID: "audit-compatible", id: "audit-model" }),
        expect.objectContaining({ providerID: "audit-openrouter", id: "audit-model" }),
      ]),
    )
    expect(body.data.some((model: { providerID: string }) => model.providerID === "audit-azure")).toBe(false)
  }, 30000)

  test("reads and cancels durable task inputs whose IDs exceed the router default", async () => {
    await using tmp = await tmpdir({ git: true })
    const id = `ses_task_${"parent_assistant_call_".repeat(7)}`
    const messageID = `msg_task_${"parent_assistant_call_".repeat(7)}`
    const created = await request("/api/session", tmp.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, location: { directory: tmp.path } }),
    })
    expect(created.status).toBe(200)
    const read = await request(`/api/session/${id}`, tmp.path)
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ data: { id } })
    const admitted = await request(`/api/session/${id}/prompt`, tmp.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: messageID, prompt: { text: "admit only" }, delivery: "queue", resume: false }),
    })
    expect(admitted.status).toBe(200)
    const cancelled = await request(`/api/session/${id}/input/${messageID}/cancel`, tmp.path, { method: "POST" })
    expect(cancelled.status).toBe(200)
    expect((await request(`/api/session/${id}/input/pending`, tmp.path)).status).toBe(200)
  })

  test("decodes EventV2 location refs without resolved project metadata", () => {
    expect(
      Schema.decodeUnknownSync(Event)({
        id: "evt_test",
        type: "file.watcher.updated",
        location: { directory: "/tmp/project" },
        data: {},
      }),
    ).toMatchObject({ location: { directory: "/tmp/project" } })
  })

  test("returns command and skill snapshots with resolved locations", async () => {
    await using tmp = await tmpdir({ git: true })

    for (const route of ["/api/command", "/api/skill"]) {
      const response = await request(route, tmp.path)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        location: { directory: string; project: { id: string } }
        data: unknown
      }
      expect(body.data).toBeArray()
      expect(body.location.directory).toBe(tmp.path)
      expect(body.location.project.id).toBeTruthy()
    }
  })

  test("streams native EventV2 payloads across locations", async () => {
    await using subscriber = await tmpdir({ git: true })
    await using publisher = await tmpdir({ git: true })
    const response = await request("/api/event", subscriber.path)
    const reader = eventStream(response.body!)
    const connected = await readEvent(reader)
    expect(connected.type).toBe("server.connected")
    expect(connected.location).toBeUndefined()

    const created = await request("/api/session", publisher.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: { directory: publisher.path } }),
    })
    expect(created.status).toBe(200)
    expect(await readEventType(reader, "session.next.created")).toMatchObject({
      type: "session.next.created",
      location: { directory: publisher.path },
      data: { sessionID: expect.any(String) },
    })
    await reader.return(undefined)
  })
})
