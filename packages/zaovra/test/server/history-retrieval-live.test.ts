import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"
import { generateHistoryLive, answerHistoryLive, type HistoryLiveHost } from "../../script/evaluation/history-live"
import { prepare, sha256 } from "../../script/evaluation/history-library"
import { withJournal } from "../../script/evaluation/history-journal"

const TEST_KEY = "local-fixed-fixture"
type Native = {
  model: string
  input?: Array<{ role: string; content: string }>
  messages?: Array<{ role: string; content: string }>
  max_output_tokens?: number
  max_tokens?: number
  stream: boolean
}

async function fixture(dir: string, docs = 3) {
  const library = path.join(dir, "source")
  const source = path.join(library, "record")
  await mkdir(source, { recursive: true })
  const entries = []
  for (let id = 1; id <= docs; id++) {
    const basename = "record-" + id + ".md"
    const text = "marker: fixed capital " + id
    await Bun.write(path.join(source, basename), text)
    entries.push({ file: "record/" + basename, title: "record " + id, sha256: sha256(text) })
  }
  const manifest = path.join(dir, "manifest.json")
  const material = path.join(dir, "material")
  await Bun.write(manifest, JSON.stringify(entries))
  await prepare(library, manifest, material)
  const questions = path.join(dir, "questions.json")
  await Bun.write(
    questions,
    JSON.stringify(
      Array.from({ length: 25 }, (_, id) => ({
        id: id + 1,
        question: "What does record say? " + (id + 1),
        goldenSelector: "private-scoring-marker",
      })),
    ),
  )
  return { input: path.join(material, "generation-input.json"), corpus: path.join(material, "corpus.json"), questions }
}

function succeed(protocol: "chat" | "responses", value: unknown, counts?: { input: number; output: number }) {
  const text = JSON.stringify(value)
  return protocol === "chat"
    ? Response.json({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }],
        ...(counts
          ? {
              usage: {
                prompt_tokens: counts.input,
                completion_tokens: counts.output,
                total_tokens: counts.input + counts.output,
                prompt_tokens_details: { cached_tokens: 2 },
                completion_tokens_details: { reasoning_tokens: 1 },
              },
            }
          : {}),
      })
    : Response.json({
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        ...(counts
          ? {
              usage: {
                input_tokens: counts.input,
                output_tokens: counts.output,
                total_tokens: counts.input + counts.output,
                input_tokens_details: { cached_tokens: 2 },
                output_tokens_details: { reasoning_tokens: 1 },
              },
            }
          : {}),
      })
}

function setup(root: string, port: number, maxSends: number, maxTokens = 200_000): HistoryLiveHost {
  return {
    mode: "loopback",
    root,
    cap: { maxSends, maxTokens },
    credential: () => TEST_KEY,
    request: (slot) => ({
      route: slot.phase === "generation" ? "generation" : "qa-" + slot.arm,
      baseURL: "http://127.0.0.1:" + port + "/v1",
      protocol: slot.phase === "qa" && slot.arm !== "both" ? "chat" : "responses",
      model: slot.phase === "generation" ? "gen-model" : "qa-" + slot.arm,
      context: slot.phase === "generation" ? "generate independently" : "fresh-slot-" + slot.id,
      maxRequestBytes: 60_000,
      maxOutputTokens: 80,
      reserveTokens: 130,
      maxSends: 6,
      maxAttempts: 2,
      timeoutMs: 5000,
    }),
  }
}

test("generation and all 75 slots use scoped native requests with durable retry and replay", async () => {
  await using temporary = await tmpdir()
  const material = await fixture(temporary.path)
  const root = path.join(temporary.path, "campaign")
  const sent: Array<{ model: string; data: unknown }> = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      expect(req.headers.get("authorization")).toBe("Bearer " + TEST_KEY)
      const wire = (await req.json()) as Native
      const protocol = new URL(req.url).pathname.endsWith("/responses") ? "responses" : "chat"
      expect(wire.stream).toBe(false)
      expect(wire.max_output_tokens ?? wire.max_tokens).toBe(80)
      const [system, user] = (wire.input ?? wire.messages)!
      expect(user.content).not.toContain("private-scoring-marker")
      expect(user.content).not.toContain(TEST_KEY)
      const data = JSON.parse(user.content)
      sent.push({ model: wire.model, data })
      if (wire.model === "gen-model") {
        expect(Object.keys(data).sort()).toEqual(["id", "text", "title"])
        expect(system.content).toContain("generate independently")
        if (sent.length === 1) return Response.json({ error: "fixed retry" }, { status: 503 })
        return succeed(
          protocol,
          { title: data.title, summary: "fixed marker", body: data.text },
          data.id === "doc-2" ? undefined : { input: 20, output: 8 },
        )
      }
      expect(Object.keys(data).sort()).toEqual(["question", "tools", "transcript"])
      expect(system.content).toContain("fresh-slot-" + data.question.split(" ").at(-1))
      const history = data.transcript
      if (!history.length) {
        return succeed(
          protocol,
          data.tools.includes("list")
            ? { action: "list", query: "" }
            : {
                action: "search",
                query: "marker",
              },
          { input: 20, output: 8 },
        )
      }
      const result = history.at(-1).result
      if (result.action === "list") {
        return succeed(protocol, { action: "read", ref: result.pages[0].ref }, { input: 20, output: 8 })
      }
      expect(result.excerpts[0].text).toContain("marker")
      return succeed(
        protocol,
        { action: "answer", answer: "fixed", citations: [result.excerpts[0].handle] },
        { input: 30, output: 5 },
      )
    },
  })
  try {
    const interrupted = await generateHistoryLive(setup(root, upstream.port!, 1), material.input)
    expect(interrupted).toMatchObject({ pause: "campaign-send-limit", generated: 0, usage: { sends: 1, unknown: 1 } })
    expect(sent).toHaveLength(1)
    const generated = await generateHistoryLive(setup(root, upstream.port!, 4), material.input)
    expect(generated).toMatchObject({
      generated: 3,
      failed: [],
      usage: { sends: 4, known: 2, unknown: 2, knownTokens: 56, unknownReserve: 260 },
    })
    expect(sent).toHaveLength(4)
    expect(generated.drafts).toBeDefined()
    const endpoint = { ...material, drafts: generated.drafts! }
    const partial = await answerHistoryLive(setup(root, upstream.port!, 5), endpoint)
    expect(partial).toMatchObject({ pause: "campaign-send-limit", counts: { search: 0, pages: 0, both: 0 } })
    expect(sent).toHaveLength(5)
    const usage = await Bun.file(path.join(partial.output, "accounting.json")).json()
    expect(
      usage.sends.map((x: { slot: string; attempt: number; outcome: string }) => [x.slot, x.attempt, x.outcome]),
    ).toEqual([
      ["generation/doc-1", 1, "retryable"],
      ["generation/doc-1", 2, "ok"],
      ["generation/doc-2", 1, "ok"],
      ["generation/doc-3", 1, "ok"],
      ["qa/search/1", 1, "ok"],
    ])
    expect(usage.sends[1].usage).toMatchObject({ input: 20, output: 8, cachedInput: 2, reasoning: 1, total: 28 })
    expect(usage.sends[2].usage).toBeNull()
    const completed = await answerHistoryLive(setup(root, upstream.port!, 204), endpoint)
    expect(completed).toMatchObject({ counts: { search: 25, pages: 25, both: 25 }, usage: { sends: 204, unknown: 2 } })
    expect(completed.pause).toBeUndefined()
    expect(sent).toHaveLength(204)
    const modelCounts = sent.reduce(
      (counts, row) => counts.set(row.model, (counts.get(row.model) ?? 0) + 1),
      new Map<string, number>(),
    )
    expect([...modelCounts]).toEqual([
      ["gen-model", 4],
      ["qa-search", 50],
      ["qa-pages", 75],
      ["qa-both", 75],
    ])
    expect((await Bun.file(path.join(completed.output, "both", "answers.json")).json()).length).toBe(25)
    expect(await Bun.file(path.join(root, "ledger.sqlite")).text()).not.toContain(TEST_KEY)
    const rerun = await answerHistoryLive(
      { ...setup(root, upstream.port!, 204), credential: () => undefined },
      endpoint,
    )
    expect(rerun).toMatchObject({ counts: { search: 25, pages: 25, both: 25 }, usage: { sends: 204 } })
    expect(sent).toHaveLength(204)
    await expect(
      answerHistoryLive(
        {
          ...setup(root, upstream.port!, 204),
          request: (slot) => ({
            ...setup(root, upstream.port!, 204).request(slot),
            context: "changed",
          }),
        },
        endpoint,
      ),
    ).rejects.toThrow("evaluation-input-or-route-plan-changed")
  } finally {
    await upstream.stop(true)
  }
}, 60_000)

test("stopping drains one physical request, excludes a parallel writer and resumes without replaying a send", async () => {
  await using temporary = await tmpdir()
  const material = await fixture(temporary.path, 2)
  const root = path.join(temporary.path, "campaign")
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let sends = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const wire = (await req.json()) as Native
      const data = JSON.parse(wire.input![1].content)
      if (++sends === 1) {
        started.resolve()
        await release.promise
      }
      return succeed("responses", { title: data.title, summary: "summary", body: data.text }, { input: 6, output: 3 })
    },
  })
  const stop = new AbortController()
  try {
    const host = setup(root, upstream.port!, 2)
    const running = generateHistoryLive({ ...host, signal: stop.signal }, material.input)
    await started.promise
    await expect(generateHistoryLive(host, material.input)).rejects.toThrow("locked")
    stop.abort()
    release.resolve()
    const partial = await running
    expect(partial).toMatchObject({ generated: 1, pause: "host-stopped", usage: { sends: 1, known: 1 } })
    const done = await generateHistoryLive(host, material.input)
    expect(done).toMatchObject({ generated: 2, usage: { sends: 2, unknown: 0 } })
    expect(sends).toBe(2)
  } finally {
    release.resolve()
    await upstream.stop(true)
  }
})

test("token gates preserve unknown liabilities and stop on a reported reservation overrun", async () => {
  await using temporary = await tmpdir()
  const material = await fixture(temporary.path, 2)
  const root = path.join(temporary.path, "campaign")
  let sends = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      sends++
      return succeed("responses", { title: "title", summary: "summary", body: "body" }, { input: 125, output: 10 })
    },
  })
  try {
    const cap = await generateHistoryLive(setup(root, upstream.port!, 7, 129), material.input)
    expect(cap).toMatchObject({ pause: "campaign-token-limit", usage: { sends: 0 } })
    const over = await generateHistoryLive(setup(root, upstream.port!, 7, 1000), material.input)
    expect(over).toMatchObject({ pause: "reservation-overrun", usage: { sends: 1, knownTokens: 135, overrun: 1 } })
    const reopened = await generateHistoryLive(setup(root, upstream.port!, 7, 1000), material.input)
    expect(reopened).toMatchObject({ pause: "reservation-overrun", usage: { sends: 1, overrun: 1 } })
    expect(sends).toBe(1)
    const recovery = path.join(temporary.path, "crash-reservation")
    await withJournal(recovery, { maxSends: 1, maxTokens: 130 }, async (journal) => {
      journal.start(
        {
          slot: "generation/doc-1",
          step: 0,
          attempt: 1,
          requestHash: "x",
          model: "fixed",
          route: "fake/responses",
          reserve: 130,
        },
        1,
      )
    })
    await withJournal(recovery, { maxSends: 1, maxTokens: 130 }, async (journal) => {
      expect(journal.history("generation/doc-1", 0)[0].outcome).toBe("uncertain")
      expect(journal.totals()).toMatchObject({ sends: 1, unknown: 1, unknownReserve: 130 })
    })
  } finally {
    await upstream.stop(true)
  }
})
