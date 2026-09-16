export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model, type Usage } from "@zaovra-ai/llm"
import { usageTokens, usageReported } from "./usage-tokens"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"
import { and, desc, eq } from "drizzle-orm"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Preserve the original objective, latest user corrections, authorization boundaries, and unfinished requirements.
- Distinguish implemented changes from verified results. Record deferred checks and failed approaches without claiming success.
- Record pending operations and uncertain side effects so continuation can inspect their state before repeating them.
- Keep references to retained tool output and the next concrete action needed to resume the existing task.
- Do not mention the summary process or that context was compacted.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
}

type Dependencies = {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
  readonly reason?: "auto" | "manual"
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string, limit = TOOL_OUTPUT_MAX_CHARS) =>
  value.length <= limit ? value : `${value.slice(0, limit / 2)}\n[truncated middle]\n${value.slice(-limit / 2)}`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"], structured?: unknown) =>
  content.length === 0 && structured !== undefined
    ? JSON.stringify(structured)
    : content
        .map((item) =>
          item.type === "text"
            ? item.text
            : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
        )
        .join("\n")

const serialize = (message: SessionMessage.Message, reduced = false) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${reduced ? truncate(part.text) : part.text}`]
        if (part.type === "reasoning")
          return part.text ? [reduced ? "[Assistant reasoning omitted]" : `[Assistant reasoning]: ${part.text}`] : []
        const raw = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        const input = reduced ? truncate(raw, 512) : raw
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content, part.state.structured), reduced ? 512 : TOOL_OUTPUT_MAX_CHARS)}`,
            ...(part.state.outputPaths ?? []).map((path) => `[Retained tool output]: ${path}`),
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call ${part.state.status}; outcome unknown]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell")
    return `[Shell]: ${message.command}\n${truncate(message.output, reduced ? 512 : TOOL_OUTPUT_MAX_CHARS)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
  )
}

const select = (
  entries: readonly Entry[],
  tokens: number,
  reduced = false,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => serialize(entry.message, reduced))
    .filter(Boolean)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  let splitPrefix = ""
  let splitSuffix = ""
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > tokens) {
      const remaining = Math.max(0, tokens - total) * 4
      if (remaining > 0) {
        splitPrefix = conversation[index].slice(0, -remaining)
        splitSuffix = conversation[index].slice(-remaining)
        split = index + 1
      }
      break
    }
    total = next
    split = index
  }
  return {
    head: [...conversation.slice(0, splitSuffix ? split - 1 : split), splitPrefix].filter(Boolean).join("\n\n"),
    recent: [splitSuffix, ...conversation.slice(split)].filter(Boolean).join("\n\n"),
  }
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history that follows.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

// Reduce observations before sacrificing user requirements or the previous handoff.
const prepareSummary = (input: Input, tokens: number, budget: number) => {
  const previous = input.entries.findLast((entry) => entry.message.type === "compaction")?.message
  const latestUser = input.entries.findLast((entry) => entry.message.type === "user")?.message
  for (const reduced of [false, true]) {
    const selected = select(input.entries, tokens, reduced)
    if (!selected) continue
    const prompt = buildPrompt({
      previousSummary: previous?.type === "compaction" ? previous.summary : undefined,
      context: [
        reduced
          ? "Older observations were shortened with omission markers. Do not infer success from omitted content; the full transcript remains stored."
          : "",
        previous?.type === "compaction" ? previous.recent : "",
        selected.head || selected.recent,
        latestUser
          ? `Latest user request (may also appear in recent context; use it to update the objective, not as completed work):\n${serialize(latestUser)}`
          : "",
      ].filter(Boolean),
    })
    if (estimate([Message.user(prompt)]) <= budget) return { recent: selected.head ? selected.recent : "", prompt }
  }
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const failedSources = new Map<SessionSchema.ID, number>()
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens)
    if (!selected || (!selected.head && !input.entries.some((entry) => entry.message.type === "compaction")))
      return false
    const sourceSequence =
      input.entries.findLast(
        (entry) =>
          entry.message.type !== "compaction" &&
          !(entry.message.type === "assistant" && entry.message.error && entry.message.content.length === 0),
      )?.seq ?? 0
    if ((input.reason ?? "auto") === "auto") {
      const latestFailure = yield* dependencies.db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, input.sessionID),
            eq(EventTable.type, EventV2.versionedType("session.next.compaction.failed", 1)),
          ),
        )
        .orderBy(desc(EventTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (
        failedSources.get(input.sessionID) === sourceSequence ||
        latestFailure?.data.sourceSequence === sourceSequence
      )
        return false
    }
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    const prepared = prepareSummary(input, config.tokens, context - summaryOutput)
    if (!prepared) return false
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: input.reason ?? "auto",
      sourceSequence,
    })

    const chunks: string[] = []
    let usage: Usage | undefined
    let failure: string | undefined
    let finished = false
    const summarized = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          messages: [Message.user(prepared.prompt)],
          tools: [],
          generation: { maxTokens: summaryOutput },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failure = event.message
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          if (LLMEvent.is.stepFinish(event)) {
            usage = event.usage
            finished = event.reason === "stop"
          }
          if (LLMEvent.is.finish(event)) {
            usage = event.usage ?? usage
            finished = event.reason === "stop"
          }
          return Effect.void
        }),
        Effect.as(true),
        Effect.timeout("2 minutes"),
        Effect.catchTag("TimeoutError", () => {
          failure = "Compaction exceeded its 2 minute deadline"
          return Effect.succeed(false)
        }),
        Effect.catchTag("LLM.Error", (error) => {
          failure = error.reason.message
          return Effect.succeed(false)
        }),
      )
    const summary = chunks.join("")
    if (!summarized || failure || !finished || !summary.trim()) {
      failedSources.set(input.sessionID, sourceSequence)
      yield* dependencies.events.publish(SessionEvent.Compaction.Failed, {
        sessionID: input.sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        reason: input.reason ?? "auto",
        sourceSequence,
        error: {
          type: "unknown",
          message:
            failure ?? (finished ? "Compaction returned an empty summary" : "Compaction did not finish normally"),
        },
        usage: { providerID: input.model.provider, tokens: usageTokens(usage), reported: usageReported(usage) },
      })
      return false
    }
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: input.reason ?? "auto",
      sourceSequence,
      text: summary,
      recent: prepared.recent,
      usage: { providerID: input.model.provider, tokens: usageTokens(usage), reported: usageReported(usage) },
    })
    failedSources.delete(input.sessionID)
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    if (
      estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) <=
      context - Math.max(output, config.buffer)
    )
      return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
