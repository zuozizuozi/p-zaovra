import path from "node:path"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { fingerprint, loadCorpus, loadDrafts, readJson, sha256 } from "./history-library"
import type { Arm } from "./history-product"

const bank = Schema.Array(Schema.Struct({ id: Schema.Int, question: Schema.String }))
const action = Schema.Union([
  Schema.Struct({ action: Schema.Literal("search"), query: Schema.String }),
  Schema.Struct({ action: Schema.Literal("list"), query: Schema.String }),
  Schema.Struct({ action: Schema.Literal("read"), ref: Schema.String, offset: Schema.optional(Schema.Int) }),
  Schema.Struct({ action: Schema.Literal("answer"), answer: Schema.String, citations: Schema.Array(Schema.String) }),
  Schema.Struct({ action: Schema.Literal("abstain") }),
])
const response = Schema.Struct({
  decision: action,
  tokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
const decodeResponse = Schema.decodeUnknownSync(response)
type Action = typeof action.Type
type Tool = Exclude<Action["action"], "answer" | "abstain">
type Result =
  | { action: "list"; pages: ReadonlyArray<{ ref: string; title: string; summary: string }> }
  | {
      action: "search" | "read"
      excerpts: ReadonlyArray<{ handle: string; title: string; text: string }>
      nextOffset?: number
    }
type Transcript = ReadonlyArray<{ call: Exclude<Action, { action: "answer" | "abstain" }>; result: Result }>
export const limits = {
  turns: 7,
  calls: 6,
  queryChars: 256,
  answerChars: 1024,
  excerptChars: 2000,
  outputCharsPerCall: 4096,
  deadlineMs: 120_000,
  maxOutputTokens: 768,
} as const
const tools: Record<Arm, ReadonlyArray<Tool>> = {
  search: ["search"],
  pages: ["list", "read"],
  both: ["search", "list", "read"],
}
export type Respond = (
  turn: Readonly<{
    question: string
    tools: ReadonlyArray<Tool>
    transcript: Transcript
    limits: typeof limits
    signal: AbortSignal
  }>,
) => Promise<typeof response.Type>

// A trusted mainline adapter should open a fresh model request context per slot, honor the
// limit and signal, and account for every send. This script contains no model transport.
export type ResponderFactory = () => Respond

type Options = {
  corpus: string
  drafts: string
  questions: string
  output: string
}

const writeJson = (file: string, value: unknown) =>
  writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" })
const clip = (text: string, chars: number) => Array.from(text).slice(0, chars).join("")
function governed(respond: Respond, turn: Parameters<Respond>[0]) {
  return new Promise<Awaited<ReturnType<Respond>>>((resolve, reject) => {
    const abort = () => reject(new Error("question-deadline"))
    turn.signal.throwIfAborted()
    turn.signal.addEventListener("abort", abort, { once: true })
    Promise.resolve()
      .then(() => respond(turn))
      .then(resolve, reject)
      .finally(() => turn.signal.removeEventListener("abort", abort))
  })
}

export async function evaluate(options: Options, factory: ResponderFactory) {
  if (!path.isAbsolute(options.output)) throw new Error("absolute-evaluation-output-required")
  const corpus = await loadCorpus(options.corpus)
  const drafts = await loadDrafts(options.drafts, corpus)
  await mkdir(options.output)
  const output = await realpath(options.output)
  // Product modules resolve global paths at import time. The entrypoint uses a dedicated
  // process with disposable global paths and replaces the database layer for every arm.
  const profile = path.join(output, "profile")
  const directories = {
    XDG_DATA_HOME: "data",
    XDG_CONFIG_HOME: "config",
    XDG_STATE_HOME: "state",
    XDG_CACHE_HOME: "cache",
    ZAOVRA_CONFIG_DIR: "config",
    ZAOVRA_TEST_HOME: "home",
    ZAOVRA_TEST_MANAGED_CONFIG_DIR: "managed",
    TMP: "tmp",
    TEMP: "tmp",
    TMPDIR: "tmp",
  }
  for (const [variable, directory] of Object.entries(directories)) {
    const target = path.join(profile, directory)
    await mkdir(target, { recursive: true })
    process.env[variable] = target
  }
  process.env.ZAOVRA_DB = ":memory:"
  const { arms, openLibrary } = await import("./history-product")
  // Bind the exact imported material before opening the question bank.
  await writeJson(path.join(output, "input-lock.json"), {
    originalCorpusHash: fingerprint(corpus.documents),
    corpusHash: drafts.corpusHash,
    draftsHash: sha256(JSON.stringify(drafts)),
    generator: drafts.generator,
    limits,
  })
  const questions = await readJson(options.questions, bank)
  if (
    questions.length !== 25 ||
    questions.some((item, index) => item.id !== index + 1 || !item.question.trim() || item.question.length > 1024)
  )
    throw new Error("expected-25-numbered-questions")
  for (const arm of arms) {
    const directory = path.join(output, arm)
    await mkdir(directory)
    const library = await openLibrary(directory, arm, corpus, drafts)
    const answers: Array<{ id: number; answer: string; citations: ReadonlyArray<string> }> = []
    const evidence = []
    const slots = []
    try {
      for (const item of questions) {
        const respond = factory()
        const transcript: Array<Transcript[number]> = []
        const owned = new Set<string>()
        const listed = new Set<string>()
        const tokenReports: Array<number | null> = []
        const signal = AbortSignal.timeout(limits.deadlineMs)
        let status = "limit"
        for (let turn = 0; turn < limits.turns; ++turn) {
          tokenReports.push(null)
          const result = await governed(respond, {
            question: item.question,
            tools: [...tools[arm]],
            transcript: structuredClone(transcript),
            limits: { ...limits },
            signal,
          })
            .then(decodeResponse, () => undefined)
            .catch(() => undefined)
          if (!result) {
            status = signal.aborted ? "deadline" : "adapter-error"
            break
          }
          tokenReports[turn] = result.tokens ?? null
          const decision = result.decision
          if (decision.action === "abstain") {
            status = "abstained"
            break
          }
          if (decision.action === "answer") {
            if (
              !decision.answer.trim() ||
              decision.answer.length > limits.answerChars ||
              decision.citations.length > owned.size ||
              !decision.citations.every((handle) => owned.has(handle))
            ) {
              status = "invalid-answer"
              break
            }
            answers.push({ id: item.id, answer: decision.answer, citations: [...new Set(decision.citations)] })
            status = "answered"
            break
          }
          if (
            !tools[arm].includes(decision.action) ||
            transcript.length >= limits.calls ||
            ("query" in decision && decision.query.length > limits.queryChars) ||
            (decision.action === "read" &&
              (!listed.has(decision.ref) ||
                (decision.offset !== undefined && (decision.offset < 0 || decision.offset >= 16_384))))
          ) {
            status = "invalid-tool-call"
            break
          }
          if (decision.action === "list") {
            const pages = []
            for (const page of (await library.list(decision.query)).slice(0, 6)) {
              const entry = { ...page, title: clip(page.title, 120), summary: clip(page.summary, 280) }
              if (JSON.stringify({ action: "list", pages: [...pages, entry] }).length > limits.outputCharsPerCall) break
              listed.add(page.ref)
              pages.push(entry)
            }
            transcript.push({ call: decision, result: { action: "list", pages } })
            continue
          }
          const found =
            decision.action === "search"
              ? await library.search(decision.query)
              : [await library.read(decision.ref)].filter((page) => page !== undefined)
          const excerpts = []
          const offset = decision.action === "read" ? (decision.offset ?? 0) : 0
          let nextOffset: number | undefined
          for (const hit of found) {
            const handle = randomUUID()
            const title = clip(hit.title, 120)
            const characters = Array.from(hit.text)
            let end = Math.min(characters.length, offset + limits.excerptChars)
            let text = characters.slice(offset, end).join("")
            // JSON escaping can expand a page window. Shrink it before exposing a continuation.
            if (decision.action === "read") {
              while (
                JSON.stringify({ action: "read", excerpts: [{ handle, title, text }], nextOffset: end }).length >
                limits.outputCharsPerCall
              ) {
                end = offset + Math.floor((end - offset) / 2)
                text = characters.slice(offset, end).join("")
              }
            }
            if (!text) continue
            if (decision.action === "read" && end < characters.length) nextOffset = end
            const excerpt = { handle, title, text }
            if (
              JSON.stringify({ action: decision.action, excerpts: [...excerpts, excerpt], nextOffset }).length >
              limits.outputCharsPerCall
            )
              break
            owned.add(handle)
            excerpts.push(excerpt)
            evidence.push({
              id: item.id,
              handle,
              action: decision.action,
              request: decision,
              text,
              sources: hit.sources.map((id) => ({ id, sha256: corpus.sources[id].sha256 })),
            })
          }
          transcript.push({
            call: decision,
            result: { action: decision.action, excerpts, ...(nextOffset !== undefined ? { nextOffset } : {}) },
          })
        }
        slots.push({
          id: item.id,
          status,
          tokenReports,
          calls: transcript.map(({ call }) => call.action),
          handles: owned.size,
        })
      }
      await writeJson(path.join(directory, "answers.json"), answers)
      await writeJson(path.join(directory, "evidence.json"), evidence)
      await writeJson(path.join(directory, "run.json"), { arm, inventory: library.inventory, slots })
    } finally {
      await library.close()
    }
  }
}

export const offlineResponder: ResponderFactory =
  () =>
  async ({ question, tools, transcript }) => {
    const segment =
      question.match(/[a-z][a-z0-9_.-]{2,}/i)?.[0] ?? question.match(/[\u3400-\u9fff]{2,}/)?.[0].slice(0, 4) ?? ""
    const tried = (action: Tool) => transcript.some((step) => step.call.action === action)
    if (tools.includes("search") && !tried("search"))
      return { decision: { action: "search", query: segment }, tokens: 0 }
    if (tools.includes("list") && !tried("list")) return { decision: { action: "list", query: "" }, tokens: 0 }
    const listing = transcript.find((step) => step.result.action === "list")?.result
    if (listing?.action === "list" && !tried("read")) {
      const page =
        listing.pages.find((page) => page.title.toLowerCase().includes(segment.toLowerCase())) ?? listing.pages[0]
      if (page) return { decision: { action: "read", ref: page.ref }, tokens: 0 }
    }
    return { decision: { action: "abstain" }, tokens: 0 }
  }
