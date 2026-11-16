import { expect, test } from "bun:test"
import { Zaovra } from "@zaovra-ai/client"
import type { MessagesListOutput, SessionsOutcomeOutput } from "@zaovra-ai/client"
import { observe } from "../../../script/evaluation/memory/observe"

type Message = MessagesListOutput["data"][number]
const admission = { sessionID: "session-evaluation", id: "user-own", admittedSeq: 5 }
const user: Message = { id: admission.id, type: "user", text: "task", time: { created: 1 }, seq: 6 }
const assistant: Message = {
  id: "assistant-own",
  type: "assistant",
  turn: admission.id,
  seq: 7,
  time: { created: 2, completed: 3 },
  agent: "build",
  model: { id: "fixture", providerID: "local" },
  content: [],
}
const done = {
  state: "completed_unverified",
  outcomeUnknown: false,
  checks: [],
  missing: [],
} satisfies SessionsOutcomeOutput

function page(data: Message[], next?: string): MessagesListOutput {
  return { data, cursor: { next }, watermark: 20, execution: { epoch: 1, revision: 4, active: false }, pending: [] }
}

async function fixture(
  input: {
    messages?: Message[]
    change?: (page: MessagesListOutput, read: number) => unknown
    outcome?: unknown
    delay?: number
    status?: number
  } = {},
) {
  let reads = 0
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}${url.search}`)
      if (input.delay) await Bun.sleep(input.delay)
      if (input.status) return Response.json({ error: "fixture-secret-do-not-report" }, { status: input.status })
      if (url.pathname.endsWith("/outcome")) return Response.json({ data: input.outcome ?? done })
      expect(url.pathname).toBe(`/api/session/${admission.sessionID}/message`)
      expect(request.method).toBe("GET")
      expect(url.searchParams.has("cursor") && url.searchParams.has("order")).toBe(false)
      const data = url.searchParams.has("cursor") ? page([]) : page(input.messages ?? [user, assistant], "end")
      reads++
      return Response.json(input.change ? input.change(data, reads) : data)
    },
  })
  return {
    client: Zaovra.make({ baseUrl: server.url.toString() }),
    requests,
    async [Symbol.asyncDispose]() {
      await server.stop(true)
    },
  }
}

const quiet = async () => "quiescent" as const

test("actual generated client reads complete pages and own turn, then independently checks jobs", async () => {
  await using f = await fixture()
  const checks: unknown[] = []
  const result = await observe({
    client: f.client,
    admission,
    confirmBackground: async (check) => {
      checks.push(check)
      return "quiescent"
    },
  })
  expect(result.artifactReady).toBe(true)
  expect(result.turn).toEqual({
    admitted: true,
    promoted: true,
    active: false,
    pending: 0,
    assistants: 1,
    unsettled: 0,
    outcome: "completed",
  })
  expect(result.evidence).toHaveLength(3)
  expect(checks).toEqual([{ admission, epoch: 1, revision: 4, watermark: 20, toolIDs: [] }])
  expect(f.requests).toHaveLength(7)
})

test("idle and completed do not establish background quiescence", async () => {
  await using f = await fixture()
  expect((await observe({ client: f.client, admission })).reason).toBe("background-not-independently-confirmed")
  for (const state of ["unknown", "active"] as const) {
    const result = await observe({ client: f.client, admission, confirmBackground: async () => state })
    expect(result.artifactReady).toBe(false)
    expect(result.turn).toBeUndefined()
  }
})

test("an old completed assistant cannot promote the new admission", async () => {
  await using f = await fixture({
    messages: [
      { ...user, id: "old-user", seq: 1 },
      { ...assistant, turn: "old-user", seq: 2 },
    ],
  })
  expect((await observe({ client: f.client, admission, confirmBackground: quiet })).reason).toBe(
    "admission-not-promoted",
  )
})

for (const [name, messages] of [
  ["no own assistant", [user]],
  ["unknown turn", [user, { ...assistant, turn: undefined }]],
  ["foreign turn after own user", [user, { ...assistant, id: "other", turn: "old" }, assistant]],
  ["later user", [user, assistant, { ...user, id: "new-user", seq: 8 }]],
  ["incorrect promotion sequence", [{ ...user, seq: 4 }, assistant]],
  ["unsettled assistant", [user, { ...assistant, time: { created: 2 } }]],
  ["terminated assistant", [user, { ...assistant, termination: { category: "budget", message: "limit" } }]],
] satisfies Array<[string, Message[]]>)
  test(name, async () => {
    await using f = await fixture({ messages })
    const result = await observe({ client: f.client, admission, confirmBackground: quiet })
    expect(result.artifactReady).toBe(false)
    expect(result.turn).toBeUndefined()
  })

for (const field of ["execution", "pending", "watermark", "cursor"] as const)
  test(`missing ${field} stays unknown`, async () => {
    await using f = await fixture({ change: (value) => ({ ...value, [field]: undefined }) })
    expect((await observe({ client: f.client, admission, confirmBackground: quiet })).reason).toBe(
      "snapshot-fields-missing",
    )
  })

for (const change of [
  (value: MessagesListOutput) => ({ ...value, execution: { epoch: 1, revision: 4, active: true } }),
  (value: MessagesListOutput) => ({ ...value, pending: [{ id: admission.id }] }),
  (value: MessagesListOutput) => ({ ...value, execution: { epoch: -1, revision: 4, active: false } }),
])
  test("active, pending or invalid state never becomes zeros", async () => {
    await using f = await fixture({ change })
    expect((await observe({ client: f.client, admission, confirmBackground: quiet })).artifactReady).toBe(false)
  })

test("pagination changes and duplicate IDs fail closed", async () => {
  for (const change of [
    (value: MessagesListOutput, read: number) => ({ ...value, watermark: read === 2 ? 21 : 20 }),
    (value: MessagesListOutput) => ({ ...value, data: [user, user] }),
    (value: MessagesListOutput) => ({ ...value, cursor: {} }),
    (value: MessagesListOutput) => ({ ...value, data: [user], cursor: { next: "cycle" } }),
  ]) {
    await using f = await fixture({ change })
    expect((await observe({ client: f.client, admission, confirmBackground: quiet })).artifactReady).toBe(false)
  }
})

test("finite page cap refuses truncated history", async () => {
  await using f = await fixture()
  expect((await observe({ client: f.client, admission, maxPages: 1, confirmBackground: quiet })).reason).toBe(
    "page-limit",
  )
  expect(f.requests).toHaveLength(1)
})

test("changed snapshots retry only up to the explicit bound", async () => {
  await using f = await fixture({
    change: (value, read) => ({ ...value, execution: { epoch: 1, revision: Math.ceil(read / 2), active: false } }),
  })
  const result = await observe({ client: f.client, admission, attempts: 2, confirmBackground: quiet })
  expect(result.reason).toBe("snapshot-changed")
  expect(result.attempts).toBe(2)
  expect(f.requests).toHaveLength(10)
})

test("host background check is followed by another stable complete snapshot", async () => {
  await using f = await fixture({ change: (value, read) => ({ ...value, watermark: read > 4 ? 21 : 20 }) })
  expect((await observe({ client: f.client, admission, attempts: 1, confirmBackground: quiet })).reason).toBe(
    "snapshot-changed-after-background-check",
  )
})

for (const outcome of [
  { ...done, outcomeUnknown: true },
  { ...done, state: "idle" },
  { ...done, state: "failed" },
  { ...done, state: "stopped" },
  { ...done, termination: { category: "network" } },
  { ...done, runtime: "running" },
  { state: "completed" },
])
  test("noncompleted or uncertain structured outcome is not accepted", async () => {
    await using f = await fixture({ outcome })
    expect((await observe({ client: f.client, admission, confirmBackground: quiet })).reason).toBe(
      "outcome-not-completed",
    )
  })

test("settled tool error can recover; running tool cannot", async () => {
  const tool = {
    type: "tool",
    id: "call-1",
    name: "bash",
    state: {
      status: "error",
      input: {},
      content: [],
      structured: {},
      error: { type: "unknown", message: "recoverable" },
    },
    time: { created: 2, completed: 3 },
  } as const
  await using recovered = await fixture({ messages: [user, { ...assistant, content: [tool] }] })
  expect((await observe({ client: recovered.client, admission, confirmBackground: quiet })).artifactReady).toBe(true)
  await using running = await fixture({
    messages: [user, { ...assistant, content: [{ ...tool, state: { status: "pending", input: "" } }] }],
  })
  expect((await observe({ client: running.client, admission, confirmBackground: quiet })).reason).toBe(
    "assistant-or-tool-unsettled",
  )
})

test("HTTP errors, deadlines and invalid bounds do not leak payloads or pass", async () => {
  await using failed = await fixture({ status: 500 })
  const result = await observe({ client: failed.client, admission })
  expect(result.reason).toBe("observation-request-or-shape-failed")
  expect(JSON.stringify(result)).not.toContain("fixture-secret")
  await using slow = await fixture({ delay: 80 })
  expect((await observe({ client: slow.client, admission, requestTimeoutMs: 10 })).artifactReady).toBe(false)
  await using valid = await fixture()
  expect((await observe({ client: valid.client, admission, maxPages: 0 })).attempts).toBe(0)
  expect(valid.requests).toHaveLength(0)
  expect(
    (
      await observe({
        client: valid.client,
        admission,
        requestTimeoutMs: 10,
        confirmBackground: async () => {
          await Bun.sleep(80)
          return "quiescent"
        },
      })
    ).artifactReady,
  ).toBe(false)
})

test("multiple full pages are collected with opaque cursors and no order on continuation", async () => {
  await using f = await fixture({
    change: (_value, read) => {
      const part = (read - 1) % 3
      if (part === 0) return page([user], "middle")
      if (part === 1) return page([assistant], "end")
      return page([])
    },
  })
  const result = await observe({ client: f.client, admission, confirmBackground: quiet })
  expect(result.artifactReady).toBe(true)
  expect(result.evidence.map((item) => item.pages)).toEqual([3, 3, 3])
})

test("same stamps with changed content is still inconsistent evidence", async () => {
  await using f = await fixture({
    change: (value, read) =>
      read === 3
        ? page([user, { ...assistant, content: [{ type: "text", id: "new", text: "changed" }] }], "end")
        : value,
  })
  expect((await observe({ client: f.client, admission, attempts: 1, confirmBackground: quiet })).reason).toBe(
    "snapshot-changed",
  )
})

test("a new coherent sampling attempt may succeed after a changed snapshot", async () => {
  await using f = await fixture({ change: (value, read) => ({ ...value, watermark: read <= 2 ? 20 : 21 }) })
  const result = await observe({ client: f.client, admission, confirmBackground: quiet })
  expect(result.artifactReady).toBe(true)
  expect(result.attempts).toBe(2)
})
