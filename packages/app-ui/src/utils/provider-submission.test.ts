import { expect, test } from "bun:test"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { connectProviderKey, providerOperation, reconnectDisabledProviders } from "./provider-integration"

function transport(handler: (request: Request) => Promise<Response>) {
  return Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
    preconnect() {},
  })
}

const explicit = { models: [{ id: "concrete", name: "Concrete" }], saveModels: async () => {} }

function fixture() {
  const writes: string[] = []
  const client = createZaovraClient({
    baseUrl: "https://synthetic.invalid",
    fetch: transport(async (request) => {
      writes.push(await request.text())
      return new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } })
    }),
  })
  return { client, writes }
}

test("587 disposed A discovery cannot overwrite the reopened B credential or config", async () => {
  const target = fixture()
  const a = providerOperation()
  const b = providerOperation()
  const pending = Promise.withResolvers<{ id: string; name: string }[]>()
  const configurations: string[] = []
  const old = connectProviderKey({
    ...explicit,
    client: target.client,
    request: { integrationID: "same-provider", key: "synthetic-A", inputs: {} },
    current: a.start(),
    discover: () => pending.promise,
    saveModels: async () => {
      configurations.push("A")
    },
  })
  a.cancel() // Same lifetime boundary used by the form's onCleanup.
  const current = await connectProviderKey({
    ...explicit,
    client: target.client,
    request: { integrationID: "same-provider", key: "synthetic-B", inputs: {} },
    current: b.start(),
    discover: async () => [{ id: "B", name: "B" }],
    saveModels: async () => {
      configurations.push("B")
    },
  })
  pending.resolve([{ id: "A", name: "A" }])
  expect(await old).toBe(false)
  expect(current).toBe(true)
  expect(configurations).toEqual(["B"])
  expect(target.writes).toHaveLength(1)
  expect(JSON.parse(target.writes[0]).key).toBe("synthetic-B")
})

test("587 generation change after config preparation prevents the credential write", async () => {
  const target = fixture()
  const operation = providerOperation()
  const pending = Promise.withResolvers<void>()
  const old = connectProviderKey({
    ...explicit,
    client: target.client,
    request: { integrationID: "A", key: "synthetic-A", inputs: {} },
    current: operation.start(),
    discover: async () => [{ id: "concrete", name: "Concrete" }],
    saveModels: () => pending.promise,
  })
  await Promise.resolve()
  operation.start()
  pending.resolve()
  expect(await old).toBe(false)
  expect(target.writes).toEqual([])
})

test("587 reconnect removes only its own ID from the latest list after a successful key write", async () => {
  const target = fixture()
  const operation = providerOperation()
  const state = { disabled: ["provider", "other"], enabled: 0 }
  const connected = await connectProviderKey({
    ...explicit,
    client: target.client,
    request: { integrationID: "provider", key: "synthetic", inputs: {} },
    current: operation.start(),
    enable: async () => {
      expect(target.writes).toHaveLength(1)
      state.disabled.push("concurrent-choice")
      state.disabled = reconnectDisabledProviders(state.disabled, "provider", true)
      state.enabled++
    },
  })
  expect(connected).toBe(true)
  expect(state.disabled).toEqual(["other", "concurrent-choice"])
  expect(state.enabled).toBe(1)
  expect(reconnectDisabledProviders(["manual", "other"], "manual", false)).toEqual(["manual", "other"])
})

test("587 failed key save never re-enables and the current form can retry", async () => {
  const operation = providerOperation()
  const state = { failures: true, enables: 0 }
  const client = createZaovraClient({
    baseUrl: "https://synthetic.invalid",
    fetch: transport(
      async () =>
        new Response(JSON.stringify({ data: {} }), {
          status: state.failures ? 401 : 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  })
  const submit = () =>
    connectProviderKey({
      ...explicit,
      client,
      request: { integrationID: "provider", key: "synthetic", inputs: {} },
      current: operation.start(),
      enable: async () => {
        state.enables++
      },
    })
  await expect(submit()).rejects.toBeDefined()
  expect(state.enables).toBe(0)
  state.failures = false
  expect(await submit()).toBe(true)
  expect(state.enables).toBe(1)
})

test("587 disposing after dispatch does not claim cancellation or admit follow-up writes", async () => {
  const operation = providerOperation()
  const response = Promise.withResolvers<Response>()
  const state = { writes: 0, enables: 0 }
  const client = createZaovraClient({
    baseUrl: "https://synthetic.invalid",
    fetch: transport(async () => {
      state.writes++
      return response.promise
    }),
  })
  const submitted = connectProviderKey({
    ...explicit,
    client,
    request: { integrationID: "provider", key: "synthetic", inputs: {} },
    current: operation.start(),
    enable: async () => {
      state.enables++
    },
  })
  while (!state.writes) await new Promise((resolve) => setTimeout(resolve, 0))
  operation.cancel()
  response.resolve(new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } }))
  expect(await submitted).toBe(false)
  expect(state.writes).toBe(1)
  expect(state.enables).toBe(0)
})

test("587 failed enable reports the already saved credential without changing the disabled list", async () => {
  const target = fixture()
  const disabled = ["provider", "other"]
  await expect(
    connectProviderKey({
      ...explicit,
      client: target.client,
      request: { integrationID: "provider", key: "synthetic", inputs: {} },
      current: providerOperation().start(),
      enable: async () => {
        throw new Error("synthetic config failure")
      },
    }),
  ).rejects.toThrow("providerReenableFailed")
  expect(target.writes).toHaveLength(1)
  expect(disabled).toEqual(["provider", "other"])
})
