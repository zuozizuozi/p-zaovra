import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"
import { generateHistoryLive, answerHistoryLive, type HistoryLiveHost } from "../../script/evaluation/history-live"
import { fixtureDrafts, prepare, sha256 } from "../../script/evaluation/history-library"
import { withJournal } from "../../script/evaluation/history-journal"
import { resolveRequest, sendModel } from "../../script/evaluation/history-transport"

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

function succeed(
  protocol: "chat" | "responses",
  value: unknown,
  counts?: { input: number; output: number },
  model?: string,
) {
  const text = JSON.stringify(value)
  return protocol === "chat"
    ? Response.json({
        model,
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
        model,
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
          wire.model,
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
          wire.model,
        )
      }
      const result = history.at(-1).result
      if (result.action === "list") {
        return succeed(protocol, { action: "read", ref: result.pages[0].ref }, { input: 20, output: 8 }, wire.model)
      }
      expect(result.excerpts[0].text).toContain("marker")
      return succeed(
        protocol,
        { action: "answer", answer: "fixed", citations: [result.excerpts[0].handle] },
        { input: 30, output: 5 },
        wire.model,
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
      return succeed(
        "responses",
        { title: data.title, summary: "summary", body: data.text },
        { input: 6, output: 3 },
        wire.model,
      )
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
      return succeed(
        "responses",
        { title: "title", summary: "summary", body: "body" },
        { input: 125, output: 10 },
        "gen-model",
      )
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

test("both protocols reject missing and wrong model declarations while keeping costs across reopen", async () => {
  await using temporary = await tmpdir()
  const observed: string[] = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const request = (await req.json()) as Native
      const protocol = request.messages ? "chat" : "responses"
      const { example } = JSON.parse((request.messages ?? request.input)![1].content)
      observed.push(protocol + "/" + example)
      const label =
        example === "wrong"
          ? "another-family"
          : example === "missing"
            ? undefined
            : example === "alias" || example === "undeclared"
              ? "fixed-model-2026"
              : example === "unsafe"
                ? TEST_KEY
                : request.model
      return succeed(protocol, { answer: "7" }, { input: 9, output: 3 }, label)
    },
  })
  try {
    for (const protocol of ["chat", "responses"] as const) {
      const root = path.join(temporary.path, protocol)
      const host = setup(root, upstream.port!, 20)
      const policy = resolveRequest(
        {
          ...host.request({ phase: "generation", document: "doc-1" }),
          protocol,
          model: "fixed-model",
        },
        "loopback",
      )
      const trusted = resolveRequest(
        {
          ...policy,
          modelAliases: [{ reported: "fixed-model-2026", evidence: "fixture-probe:model-id" }],
        },
        "loopback",
      )
      expect(() =>
        resolveRequest(
          {
            ...policy,
            modelAliases: [{ reported: "fixed-model-2026", evidence: "" }],
          },
          "loopback",
        ),
      ).toThrow("invalid-model-alias-policy")
      const invoke = (example: string, route = policy) =>
        withJournal(root, host.cap, async (journal) => {
          return sendModel(
            journal,
            host,
            route,
            { slot: example, step: 0, system: "test", data: { example } },
            (v) => v,
          )
        })
      const before = observed.length
      expect((await invoke("exact")).value).toEqual({ answer: "7" })
      expect((await invoke("exact")).value).toEqual({ answer: "7" })
      expect((await invoke("alias", trusted)).value).toEqual({ answer: "7" })
      expect((await invoke("alias", trusted)).value).toEqual({ answer: "7" })
      for (const [example, reason] of [
        ["wrong", "mismatch"],
        ["missing", "missing"],
        ["undeclared", "mismatch"],
        ["unsafe", "invalid"],
      ]) {
        await expect(invoke(example)).rejects.toThrow("upstream-model-" + reason)
        await expect(invoke(example)).rejects.toThrow("recorded-model-rejected")
      }
      await expect(invoke("undeclared", trusted)).rejects.toThrow("evaluation-request-changed-on-replay")
      expect(observed).toHaveLength(before + 6)
      await withJournal(root, host.cap, async (journal) => {
        const accounting = journal.accounting()
        expect(accounting.totals).toMatchObject({ sends: 6, known: 6, knownTokens: 72 })
        expect(accounting.sends.map((row) => [row.modelStatus, row.reportedModel, row.modelEvidence])).toEqual([
          ["exact", "fixed-model", null],
          ["alias", "fixed-model-2026", "fixture-probe:model-id"],
          ["mismatch", "another-family", null],
          ["missing", null, null],
          ["mismatch", "fixed-model-2026", null],
          ["invalid", null, null],
        ])
        for (const slot of ["wrong", "missing", "undeclared", "unsafe"]) {
          expect(journal.history(slot, 0)[0].value).toBeNull()
        }
      })
      const old = new Database(path.join(root, "ledger.sqlite"))
      try {
        for (const column of ["reportedModel", "modelStatus", "modelEvidence"])
          old.exec("ALTER TABLE sends DROP COLUMN " + column)
      } finally {
        old.close()
      }
      await expect(invoke("exact")).rejects.toThrow("recorded-model-unverified")
      expect(observed).toHaveLength(before + 6)
    }
  } finally {
    await upstream.stop(true)
  }
})

test("unverified upstream models contribute costs without producing any answer rows", async () => {
  await using temporary = await tmpdir()
  const material = await fixture(temporary.path)
  const drafts = path.join(temporary.path, "drafts.json")
  await fixtureDrafts(material.input, drafts)
  let physical = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const request = (await req.json()) as Native
      const model = ++physical === 2 ? undefined : "unrelated-model"
      return succeed(
        request.messages ? "chat" : "responses",
        { action: "answer", answer: "7", citations: [] },
        { input: 9, output: 3 },
        model,
      )
    },
  })
  try {
    const root = path.join(temporary.path, "campaign")
    const host = setup(root, upstream.port!, 3)
    const first = await answerHistoryLive(host, { ...material, drafts })
    expect(first).toMatchObject({
      counts: { search: 1, pages: 1, both: 1 },
      pause: "campaign-send-limit",
      usage: { sends: 3, known: 3, knownTokens: 36 },
    })
    for (const arm of ["search", "pages", "both"]) {
      expect(await Bun.file(path.join(first.output, arm, "answers.json")).json()).toEqual([])
    }
    const second = await answerHistoryLive(host, { ...material, drafts })
    expect(second).toMatchObject({ counts: first.counts, usage: { sends: 3 } })
    expect(physical).toBe(3)
  } finally {
    await upstream.stop(true)
  }
})

test("invalid answers retain only a diagnostic category and never resend on replay", async () => {
  await using temporary = await tmpdir()
  const cases = [
    ["response-incomplete", "ignored"],
    ["assistant-text-unavailable", ""],
    ["credential-in-output", TEST_KEY],
    ["markdown-fence", "```json\n{}\n```"],
    ["invalid-json", "not JSON"],
    ["schema-mismatch", '{"wrong":"field"}'],
  ] as const
  let sent = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const [reason, text] = cases[sent++ % cases.length]!
      return Response.json({
        model: "fixed-model",
        status: reason === "response-incomplete" ? "incomplete" : "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
      })
    },
  })
  try {
    const host = setup(temporary.path, upstream.port!, cases.length)
    const policy = resolveRequest({
      ...host.request({ phase: "generation", document: "doc-1" }),
      protocol: "responses",
      model: "fixed-model",
    }, "loopback")
    for (const [reason] of cases) {
      const invoke = () => withJournal(host.root, host.cap, async (journal) =>
        sendModel(journal, host, policy, { slot: reason, step: 0, system: "test", data: {} }, () => {
          throw new Error("private diagnostic details")
        }),
      )
      await expect(invoke()).rejects.toThrow("invalid-model-output:" + reason)
      await expect(invoke()).rejects.toThrow("recorded-invalid-output")
    }
    expect(sent).toBe(cases.length)
    await withJournal(host.root, host.cap, async (journal) => {
      const report = journal.accounting()
      expect(report.sends.map((send) => send.outputFailure)).toEqual(cases.map(([reason]) => reason))
      expect(report.totals.knownTokens).toBe(cases.length * 12)
      expect(JSON.stringify(report)).not.toContain(TEST_KEY)
      expect(JSON.stringify(report)).not.toContain("private diagnostic details")
    })
  } finally {
    await upstream.stop(true)
  }
})

test("Responses selects a single final assistant message after commentary and refuses ambiguous output", async () => {
  await using temporary = await tmpdir()
  const msg = (phase?: string, text = '{"action":"abstain"}') => ({
    type: "message", role: "assistant", status: "completed", phase, content: [{ type: "output_text", text }],
  })
  const cases = [
    { output: [msg("commentary", "working"), msg("final_answer")], valid: true },
    { output: [msg()], valid: true },
    { output: [msg("final_answer")], valid: true },
    { output: [msg("commentary")], valid: false },
    { output: [msg("final_answer"), msg("final_answer")], valid: false },
    { output: [msg(), msg("final_answer")], valid: false },
    { output: [msg("final_answer"), msg("commentary")], valid: false },
    { output: [{ ...msg("final_answer"), status: "incomplete" }], valid: false },
    { output: [msg("commentary"), { ...msg("final_answer"), content: [{ type: "refusal", refusal: "no" }] }], valid: false },
  ]
  let requests = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0, fetch() {
      return Response.json({ model: "fixed-model", status: "completed", output: cases[requests++]!.output })
    },
  })
  try {
    const host = setup(temporary.path, upstream.port!, cases.length, 2_000_000)
    const policy = resolveRequest({ ...host.request({ phase: "generation", document: "doc-1" }), model: "fixed-model", protocol: "responses" }, "loopback")
    for (const [i, c] of cases.entries()) {
      const run = withJournal(host.root, host.cap, async (journal) =>
        sendModel(journal, host, policy, { slot: String(i), step: 0, system: "test", data: {} }, (v) => v),
      )
      if (c.valid) expect((await run).value).toEqual({ action: "abstain" })
      else await expect(run).rejects.toThrow("assistant-text-unavailable")
    }
    expect(requests).toBe(cases.length)
  } finally {
    await upstream.stop(true)
  }
})

test("lookup-first is a distinct prompt condition and preserves a model's immediate abstention", async () => {
  await using temporary = await tmpdir()
  const material = await fixture(temporary.path)
  const drafts = path.join(temporary.path, "drafts.json")
  await fixtureDrafts(material.input, drafts)
  const prompts: string[] = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const wire = (await request.json()) as Native
      prompts.push((wire.input ?? wire.messages)![0].content)
      return succeed(wire.input ? "responses" : "chat", { action: "abstain" }, { input: 5, output: 2 }, wire.model)
    },
  })
  try {
    const host = setup(path.join(temporary.path, "campaign"), upstream.port!, 6)
    const inputs = { ...material, drafts }
    const result = await answerHistoryLive(host, inputs, "lookup-first", 2)
    expect(result.retrieval).toBe("lookup-first")
    expect(result.counts).toEqual({ search: 2, pages: 2, both: 2 })
    expect(prompts).toHaveLength(6)
    expect(prompts.every((prompt) => prompt.includes("Use at least one permitted retrieval tool"))).toBe(true)
    await expect(answerHistoryLive(host, inputs, "autonomous", 2)).rejects.toThrow("evaluation-input-or-route-plan-changed")
    await expect(answerHistoryLive(host, inputs)).rejects.toThrow("evaluation-input-or-route-plan-changed")
    expect(prompts).toHaveLength(6)
  } finally {
    await upstream.stop(true)
  }
})

test("a transport outage pauses the campaign after two unanswered physical sends", async () => {
  await using temporary = await tmpdir()
  const material = await fixture(temporary.path)
  const drafts = path.join(temporary.path, "drafts.json")
  await fixtureDrafts(material.input, drafts)
  const seen: string[] = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const wire = (await request.json()) as Native
      const input = (wire.input ?? wire.messages)![1].content
      seen.push(wire.model + "/" + JSON.parse(input).question)
      if (seen.length <= 2) return Response.redirect("http://127.0.0.1/unsupported")
      return succeed(wire.input ? "responses" : "chat", { action: "abstain" }, { input: 5, output: 2 }, wire.model)
    },
  })
  try {
    const result = await answerHistoryLive(setup(path.join(temporary.path, "campaign"), upstream.port!, 4), {
      ...material,
      drafts,
    })
    expect(result.pause).toBe("transport-outage")
    expect(result.usage).toMatchObject({ sends: 2, unknown: 2, unknownReserve: 260 })
    const recovered = await answerHistoryLive(setup(path.join(temporary.path, "campaign"), upstream.port!, 75), {
      ...material,
      drafts,
    })
    expect(recovered.pause).toBeUndefined()
    expect(recovered.counts).toEqual({ search: 25, pages: 25, both: 25 })
    expect(recovered.usage).toMatchObject({ sends: 75, known: 73, unknown: 2, unknownReserve: 260 })
    expect(seen.length).toBe(75)
    expect(new Set(seen).size).toBe(75)
  } finally {
    await upstream.stop(true)
  }
})
