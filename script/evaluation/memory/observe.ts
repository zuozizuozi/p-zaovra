/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { createHash } from "node:crypto"
import { Zaovra } from "@zaovra-ai/client"
import type { MessagesListOutput, SessionsPromptOutput } from "@zaovra-ai/client"
import type { Turn } from "./oracle"

type Admission = Pick<SessionsPromptOutput, "sessionID" | "id" | "admittedSeq">
type Assistant = Extract<MessagesListOutput["data"][number], { type: "assistant" }>
type Tool = Extract<Assistant["content"][number], { type: "tool" }>
export type CaptureBounds = { maxBytes: number; maxParts: number }
type TextEvidence = { messageID: string; seq: number; partID: string; index: number; text: string }
type ToolEvidence = {
  messageID: string
  seq: number
  partID: string
  index: number
  name: string
  state: Tool["state"]
  time: Tool["time"]
}
type EvidenceBinding = { admission: Admission; snapshot: Observation["evidence"][number] }
export type TurnEvidence = EvidenceBinding &
  (
    | { status: "unknown"; reason: string }
    | {
        status: "complete"
        assistantText: TextEvidence[]
        tools: ToolEvidence[]
        answer:
          | { status: "selected"; messageID: string; seq: number; partIDs: string[]; text: string }
          | { status: "unknown"; reason: string }
      }
  )
type Snapshot = {
  epoch: number
  revision: number
  watermark: number
  messages: MessagesListOutput["data"]
  fingerprint: string
  pages: number
}

/** A trusted host must independently inspect the entire isolated process/job scope.
 * This is not a model assertion, a tool output, or a proof supplied by the HTTP API.
 */
export type BackgroundCheck = {
  admission: Admission
  epoch: number
  revision: number
  watermark: number
  toolIDs: string[]
}

export type Observation = {
  status: "ready" | "incomplete" | "unknown"
  artifactReady: boolean
  admission: Admission
  reason: string
  attempts: number
  evidence: Array<{
    epoch: number
    revision: number
    watermark: number
    fingerprint: string
    pages: number
    messages: number
  }>
  turn?: Turn
  /** Explicit opt-in only. Projection order is not proof of shell subcommands or negative execution. */
  turnEvidence?: TurnEvidence
}

/** Read-only, bounded sampling of an already admitted isolated Session. */
export async function observe(input: {
  client: ReturnType<typeof Zaovra.make>
  admission: Admission
  maxPages?: number
  attempts?: number
  requestTimeoutMs?: number
  /** Bounds the exported evidence, not HTTP response allocation. No partial text is returned on overflow. */
  capture?: CaptureBounds
  confirmBackground?: (check: BackgroundCheck, signal: AbortSignal) => Promise<"quiescent" | "active" | "unknown">
}): Promise<Observation> {
  const pages = input.maxPages ?? 20
  const attempts = input.attempts ?? 2
  const timeout = input.requestTimeoutMs ?? 2_000
  const evidence: Observation["evidence"] = []
  const result = (status: Observation["status"], reason: string, attempt: number): Observation => ({
    status,
    artifactReady: false,
    admission: input.admission,
    reason,
    attempts: attempt,
    evidence,
  })
  if (
    !integer(pages, 1, 100) ||
    !integer(attempts, 1, 3) ||
    !integer(timeout, 1, 30_000) ||
    !validCapture(input.capture) ||
    !input.admission.sessionID ||
    !input.admission.id ||
    !integer(input.admission.admittedSeq, 1)
  )
    return result("unknown", "invalid-observation-bounds-or-admission", 0)

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const before = await snapshot(input.client, input.admission.sessionID, pages, timeout)
      evidence.push(summary(before))
      const outcome = await bounded(timeout, (signal) =>
        input.client.sessions.outcome({ sessionID: input.admission.sessionID }, { signal }),
      )
      const after = await snapshot(input.client, input.admission.sessionID, pages, timeout)
      evidence.push(summary(after))
      if (!same(before, after)) {
        if (attempt < attempts) continue
        return result("unknown", "snapshot-changed", attempt)
      }
      const own = after.messages.filter((message) => message.id === input.admission.id)
      if (own.length !== 1 || own[0].type !== "user") return result("incomplete", "admission-not-promoted", attempt)
      const user = own[0]
      if (!integer(user.seq, input.admission.admittedSeq) || (user.turn !== undefined && user.turn !== user.id))
        return result("unknown", "admission-projection-mismatch", attempt)
      // outcome is Session-wide; never attribute a later user's outcome to this admission.
      if (
        after.messages.some(
          (message) =>
            message.type === "user" && message.id !== user.id && (!integer(message.seq) || message.seq >= user.seq!),
        )
      )
        return result("unknown", "outcome-not-exclusive-to-admission", attempt)
      const assistants = after.messages.filter((message) => message.type === "assistant")
      if (assistants.some((message) => !message.turn || !integer(message.seq)))
        return result("unknown", "assistant-turn-or-sequence-missing", attempt)
      const current = assistants.filter((message) => message.turn === user.id)
      if (!current.length) return result("incomplete", "no-own-assistant", attempt)
      if (
        assistants.some((message) => message.seq! > user.seq! && message.turn !== user.id) ||
        current.some((message) => message.seq! <= user.seq!)
      )
        return result("unknown", "assistant-turn-conflict", attempt)
      if (
        assistants.some(
          (message) =>
            !integer(message.time?.completed, 0) ||
            !Array.isArray(message.content) ||
            message.content.some(
              (part) =>
                part.type === "tool" &&
                (!part.state ||
                  !["completed", "error"].includes(part.state.status) ||
                  !integer(part.time?.completed, 0)),
            ),
        )
      )
        return result("incomplete", "assistant-or-tool-unsettled", attempt)
      if (current.some((message) => message.error !== undefined || message.termination !== undefined))
        return result("incomplete", "own-assistant-terminated", attempt)
      if (
        !outcome ||
        outcome.outcomeUnknown !== false ||
        outcome.termination !== undefined ||
        !["completed", "completed_verified", "completed_unverified"].includes(outcome.state) ||
        (outcome.runtime !== undefined && outcome.runtime !== "completed")
      )
        return result("incomplete", "outcome-not-completed", attempt)
      if (!input.confirmBackground) return result("unknown", "background-not-independently-confirmed", attempt)
      const background = await bounded(timeout, (signal) =>
        input.confirmBackground!(
          {
            admission: input.admission,
            epoch: after.epoch,
            revision: after.revision,
            watermark: after.watermark,
            toolIDs: assistants.flatMap((message) =>
              message.content.filter((part) => part.type === "tool").map((part) => part.id),
            ),
          },
          signal,
        ),
      )
      if (background !== "quiescent")
        return result(background === "active" ? "incomplete" : "unknown", "background-not-quiescent", attempt)
      // The host job inspection may take time. Bracket it with another complete stable read.
      const final = await snapshot(input.client, input.admission.sessionID, pages, timeout)
      evidence.push(summary(final))
      if (!same(after, final)) {
        if (attempt < attempts) continue
        return result("unknown", "snapshot-changed-after-background-check", attempt)
      }
      return {
        ...result("ready", "own-turn-completed-and-host-quiescent", attempt),
        artifactReady: true,
        ...(input.capture ? { turnEvidence: capture(final, input.admission, input.capture) } : {}),
        turn: {
          admitted: true,
          promoted: true,
          active: false,
          pending: 0,
          assistants: current.length,
          unsettled: 0,
          outcome: "completed",
        },
      }
    } catch (error) {
      // Never retain server error payloads, response headers, or model-controlled text.
      return result(
        "unknown",
        error instanceof ObservationError ? error.message : "observation-request-or-shape-failed",
        attempt,
      )
    }
  }
  return result("unknown", "attempt-limit", attempts)
}

class ObservationError extends Error {}

export function validCapture(capture: CaptureBounds | undefined) {
  return (
    capture === undefined ||
    (capture !== null &&
      typeof capture === "object" &&
      integer(capture.maxBytes, 1, 262144) &&
      integer(capture.maxParts, 1, 1000))
  )
}

function capture(snapshot: Snapshot, admission: Admission, bounds: CaptureBounds): TurnEvidence {
  const binding = { admission, snapshot: summary(snapshot) }
  const unknown = (reason: string): TurnEvidence => ({ ...binding, status: "unknown", reason })
  const messages = snapshot.messages
    .filter((message): message is Assistant => message.type === "assistant" && message.turn === admission.id)
    .sort((a, b) => a.seq! - b.seq!)
  if (new Set(messages.map((message) => message.seq)).size !== messages.length)
    return unknown("ambiguous-message-order")
  if (messages.reduce((count, message) => count + message.content.length, 0) > bounds.maxParts)
    return unknown("part-limit")
  const assistantText: TextEvidence[] = []
  const tools: ToolEvidence[] = []
  for (const message of messages) {
    const ids = new Set<string>()
    for (const [index, part] of message.content.entries()) {
      if (typeof part.id !== "string" || !part.id || ids.has(part.id)) return unknown("ambiguous-part-identity")
      ids.add(part.id)
      const ref = { messageID: message.id, seq: message.seq!, partID: part.id, index }
      if (part.type === "text" && !part.superseded) assistantText.push({ ...ref, text: part.text })
      if (part.type === "tool") {
        if (part.time.pruned !== undefined) return unknown("tool-result-pruned")
        tools.push({ ...ref, name: part.name, state: part.state, time: part.time })
      }
    }
  }
  // Conservative final-answer selection: only unsuperseded text in the latest assistant,
  // and never an assistant that also calls a tool. Do not fall back to earlier commentary.
  const last = messages.at(-1)!
  const text = assistantText.filter((part) => part.messageID === last.id)
  const answer =
    !last.content.some((part) => part.type === "tool") && text.some((part) => part.text.trim())
      ? {
          status: "selected" as const,
          messageID: last.id,
          seq: last.seq!,
          partIDs: text.map((part) => part.partID),
          text: text.map((part) => part.text).join(""),
        }
      : { status: "unknown" as const, reason: "no-unambiguous-final-text" }
  const result: TurnEvidence = { ...binding, status: "complete", assistantText, tools, answer }
  if (Buffer.byteLength(JSON.stringify(result)) > bounds.maxBytes) return unknown("byte-limit")
  return result
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

async function bounded<T>(timeout: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new ObservationError("observation-timeout"))
        }, timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export async function snapshot(
  client: ReturnType<typeof Zaovra.make>,
  sessionID: string,
  maxPages: number,
  timeout: number,
): Promise<Snapshot> {
  const messages: MessagesListOutput["data"][number][] = []
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  let stamp: { epoch: number; revision: number; watermark: number } | undefined
  for (let index = 0; index < maxPages; index++) {
    const page = await bounded(timeout, (signal) =>
      client.messages.list({ sessionID, limit: 100, ...(cursor ? { cursor } : { order: "asc" as const }) }, { signal }),
    )
    if (
      !page ||
      !Array.isArray(page.data) ||
      page.data.length > 100 ||
      !page.cursor ||
      !Array.isArray(page.pending) ||
      !page.execution ||
      !integer(page.execution.epoch) ||
      !integer(page.execution.revision) ||
      !integer(page.watermark)
    )
      throw new ObservationError("snapshot-fields-missing")
    if (page.execution.active !== false || page.pending.length !== 0) throw new ObservationError("snapshot-not-idle")
    const current = { epoch: page.execution.epoch, revision: page.execution.revision, watermark: page.watermark }
    if (stamp && JSON.stringify(stamp) !== JSON.stringify(current))
      throw new ObservationError("pagination-state-changed")
    stamp = current
    for (const message of page.data) {
      if (
        !message ||
        typeof message.id !== "string" ||
        !message.id ||
        ids.has(message.id) ||
        !integer(message.seq) ||
        message.seq > page.watermark
      )
        throw new ObservationError("invalid-or-duplicate-message")
      ids.add(message.id)
      messages.push(message)
    }
    if (page.data.length === 0) {
      if (page.cursor.next != null) throw new ObservationError("empty-page-with-next")
      return {
        ...stamp,
        messages,
        pages: index + 1,
        fingerprint: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
      }
    }
    if (typeof page.cursor.next !== "string" || !page.cursor.next || cursors.has(page.cursor.next))
      throw new ObservationError("pagination-not-proven-complete")
    cursors.add(page.cursor.next)
    cursor = page.cursor.next
  }
  throw new ObservationError("page-limit")
}

function same(a: Snapshot, b: Snapshot) {
  return (
    a.epoch === b.epoch && a.revision === b.revision && a.watermark === b.watermark && a.fingerprint === b.fingerprint
  )
}

function summary(snapshot: Snapshot): Observation["evidence"][number] {
  return {
    epoch: snapshot.epoch,
    revision: snapshot.revision,
    watermark: snapshot.watermark,
    fingerprint: snapshot.fingerprint,
    pages: snapshot.pages,
    messages: snapshot.messages.length,
  }
}
