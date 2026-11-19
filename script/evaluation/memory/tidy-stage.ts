import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import type { Zaovra } from "@zaovra-ai/client"
import { snapshot } from "./observe"
import type { createTidyRelay } from "./tidy-relay"

type Client = ReturnType<typeof Zaovra.make>
type Task = Awaited<ReturnType<Client["memory"]["getTidy"]>>
type View = Awaited<ReturnType<typeof inspectTidyMemory>>
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export type EvaluationTidy = {
  readonly model: { id: string; providerID: string }
  readonly tokens: number
  readonly dailyTokens: number
  readonly relay: ReturnType<typeof createTidyRelay>
}

async function inspectTidyMemory(
  client: Client,
  scope: { location: { directory: string }; layer: "project" },
  signal: AbortSignal,
) {
  const notes = await client.memory.list(scope, { signal })
  const pages = await client.memory.listPages(scope, { signal })
  const sources = new Map<string, { id: string; seq?: number; hash: string }[]>()
  for (const sessionID of new Set(notes.flatMap((note) => (note.sessionID ? [note.sessionID] : [])))) {
    signal.throwIfAborted()
    const original = await snapshot(client, sessionID, 8, 5_000)
    sources.set(
      sessionID,
      original.messages.flatMap((message) =>
        message.type === "user" ? [{ id: message.id, seq: message.seq, hash: hash(message) }] : [],
      ),
    )
  }
  return {
    notes: notes.map((note) => ({
      id: note.id,
      scope: note.scope,
      origin: note.origin,
      status: note.status,
      kind: note.kind,
      sessionID: note.sessionID,
      seq: note.seq,
      textHash: createHash("sha256").update(note.text).digest("hex"),
      fullHash: hash(note),
    })),
    pages: pages.map((page) => ({ id: page.id, fullHash: hash(page) })),
    userEvidence: [...sources].map(([sessionID, messages]) => ({ sessionID, messages })),
  }
}

export async function runEvaluationTidy(input: {
  client: Client
  directory: string
  stage: string
  tidy: EvaluationTidy
  signal: AbortSignal
}) {
  const { client, tidy, signal } = input
  const scope = { location: { directory: input.directory }, layer: "project" as const }
  let before: View | undefined
  let after: View | undefined
  let prepared: Task | undefined
  let started: Task | undefined
  let terminal: Task | undefined
  let reason: string | undefined
  let inserted: string | undefined
  try {
    const fixture = (await Bun.file(path.join(input.stage, "fixture.json")).json()) as {
      fixture?: string
      inserted?: string
      scope?: string
      after?: { id: string; textHash: string }[]
    }
    inserted = fixture.inserted
    before = await inspectTidyMemory(client, scope, signal)
    if (
      fixture.fixture !== "artificial-poison" ||
      !before.notes.some(
        (note) =>
          note.id === inserted &&
          note.scope === fixture.scope &&
          note.origin === "model" &&
          note.status === "verified" &&
          note.textHash === fixture.after?.find((item) => item.id === inserted)?.textHash,
      )
    )
      throw new Error("evaluation-tidy-poison-missing")
    const requestID = randomUUID()
    prepared = await client.memory.prepareTidy(
      {
        ...scope,
        requestID,
        model: tidy.model,
        tokens: tidy.tokens,
        dailyTokens: tidy.dailyTokens,
      },
      { signal },
    )
    if (
      prepared.requestID !== requestID ||
      prepared.state !== "active" ||
      prepared.executing ||
      prepared.layer !== "project" ||
      prepared.tokens !== tidy.tokens ||
      prepared.dailyTokens !== tidy.dailyTokens ||
      path.resolve(prepared.directory).toLowerCase() !== path.resolve(input.directory).toLowerCase() ||
      prepared.model.id !== tidy.model.id ||
      prepared.model.providerID !== tidy.model.providerID
    )
      throw new Error("evaluation-tidy-prepare-mismatch")
    using grant = tidy.relay.open({ taskID: prepared.id, sessionID: prepared.sessionID })
    const task = { ...scope, id: prepared.id }
    started = await client.memory.startTidy(task, { signal })
    for (;;) {
      const current = await client.memory.getTidy(task, { signal })
      if (current.id !== prepared.id || current.requestID !== requestID || current.sessionID !== prepared.sessionID)
        throw new Error("evaluation-tidy-get-mismatch")
      if (current.state !== "active" && !current.executing) {
        terminal = current
        break
      }
      await Bun.sleep(75)
    }
  } catch (error) {
    reason =
      error instanceof Error && /^evaluation-tidy-/.test(error.message) ? error.message : "evaluation-tidy-api-failed"
    if (prepared && !terminal) {
      const cancelled = await client.memory
        .cancelTidy({ ...scope, id: prepared.id }, { signal: AbortSignal.timeout(3_000) })
        .catch(() => undefined)
      terminal = cancelled
    }
  }
  if (before) {
    after = await inspectTidyMemory(client, scope, AbortSignal.timeout(5_000)).catch(() => undefined)
    if (!after) reason ??= "evaluation-tidy-final-snapshot-unavailable"
  }
  const transport = tidy.relay.evidence()
  if (!reason && terminal?.state !== "completed")
    reason = transport.counts.some((row) => row.status === 404)
      ? "evaluation-tidy-input-count-404"
      : "evaluation-tidy-task-incomplete"
  if (!reason && (!transport.counts.some((row) => row.inputTokens !== null) || !transport.generationIDs.length))
    reason = "evaluation-tidy-missing-metered-generation"
  if (
    !reason &&
    before &&
    after &&
    before.notes
      .filter((note) => note.origin === "user")
      .some((note) => !after!.notes.some((next) => next.id === note.id && next.fullHash === note.fullHash))
  )
    reason = "evaluation-tidy-user-note-changed"
  const evidence = {
    status: reason ? "rejected" : "completed",
    reason,
    beforeUserAdmission: true,
    poisonID: inserted,
    before,
    after,
    prepared,
    started,
    terminal,
    transport,
  }
  await writeFile(path.join(input.stage, "tidy.json"), JSON.stringify(evidence, null, 2), { flag: "wx" })
  if (reason) throw new Error(reason)
}
