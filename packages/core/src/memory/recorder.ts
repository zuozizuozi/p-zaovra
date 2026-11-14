export * as MemoryRecorder from "./recorder"

import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Layer, Stream } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
import type { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { Hash } from "../util/hash"
import { MemoryStore } from "./store"

/**
 * Notes the host records by itself, at no model cost: checks that passed, and standing
 * instructions the user gave in their own words. Nothing here asks a model what to remember.
 */

const kinds = ["test", "typecheck", "lint", "build"] as const
type CheckKind = (typeof kinds)[number]

const runner = String.raw`(?:bun|npm|pnpm|yarn)`
const recognised: ReadonlyArray<readonly [CheckKind, RegExp]> = [
  [
    "test",
    new RegExp(
      String.raw`\b${runner}\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest)\b|\b(?:go|cargo|dotnet|mvn)\s+test\b|\bgradlew?\s+test\b`,
    ),
  ],
  ["typecheck", new RegExp(String.raw`\b${runner}\s+(?:run\s+)?typecheck\b|\btsc\b.*--noEmit\b|\bmypy\b`)],
  ["lint", new RegExp(String.raw`\b${runner}\s+(?:run\s+)?lint\b|\b(?:eslint|ruff)\b`)],
  ["build", new RegExp(String.raw`\b${runner}\s+(?:run\s+)?build\b|\b(?:go|cargo|dotnet)\s+build\b`)],
]

/** The check a command performs, from what the model declared or from the command itself. */
export function checkKind(command: string, declared?: string): CheckKind | undefined {
  const known = kinds.find((kind) => kind === declared)
  if (known) return known
  if (declared) return undefined
  return recognised.find(([, expression]) => expression.test(command))?.[0]
}

/** A passed check as a note, or nothing when the command is not something to repeat later. */
export function practice(input: { command: string; declared?: string; cwd?: string; root: string }) {
  const command = input.command.trim()
  // A script pasted inline or a one-off pipeline is not how the project is checked.
  if (!command || command.length > 160 || /[\r\n]/.test(command)) return undefined
  const kind = checkKind(command, input.declared)
  if (!kind) return undefined
  const relative = input.cwd ? path.relative(input.root, input.cwd).replaceAll("\\", "/") : ""
  const where = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : ""
  return {
    kind: "practice" as const,
    key: `check:${kind}:${where}:${command}`,
    text: `${kind}: \`${command}\`${where ? ` in ${where}` : ""}`,
    verification: "exit 0",
  }
}

const standing =
  /以后[^。！？!?\n]{0,12}?(?:都|不要|别|请|要|只|用|记得|一律)|今后|从现在(?:起|开始)|记住|永远不要|一律|from now on|going forward|remember (?:that|to)\b|\balways (?:use|run|reply|answer|write|ask)\b|\bnever (?:use|run|commit|push|delete)\b|\b(?:do not|don't) ever\b/i

/** Sentences in which the user states how things should be done from here on, word for word. */
export function standingInstructions(text: string) {
  return text
    .slice(0, 4000)
    .split(/(?<=[。！？!?\n])|(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 4 && sentence.length <= 200 && standing.test(sentence))
    .slice(0, 3)
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const store = yield* MemoryStore.Service
    const session = (id: SessionSchema.ID) =>
      db
        .select({
          project: SessionTable.project_id,
          parent: SessionTable.parent_id,
          directory: SessionTable.directory,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, id))
        .get()
        .pipe(Effect.orDie)

    // Commands of bash calls still running, for checks the model did not label.
    const commands = new Map<string, string>()
    yield* events.subscribe(SessionEvent.Tool.Called).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.data.tool !== "bash" || typeof event.data.input.command !== "string") return
          if (commands.size >= 512) commands.delete(commands.keys().next().value!)
          commands.set(event.data.callID, event.data.input.command)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* events.subscribe(SessionEvent.Tool.Failed).pipe(
      Stream.runForEach((event) => Effect.sync(() => commands.delete(event.data.callID))),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* events.subscribe(SessionEvent.Tool.Success).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const command = commands.get(event.data.callID)
          commands.delete(event.data.callID)
          const structured = event.data.structured
          const check =
            typeof structured.verification === "object" && structured.verification !== null
              ? (structured.verification as { kind?: unknown; command?: unknown; cwd?: unknown })
              : undefined
          // Only a foreground command that finished cleanly; a job handed to the background has no result yet.
          if (structured.exit !== 0 || structured.timeout === true || structured.job_id !== undefined) return
          const text = typeof check?.command === "string" ? check.command : command
          if (!text) return
          const row = yield* session(event.data.sessionID)
          if (!row) return
          const found = practice({
            command: text,
            declared: typeof check?.kind === "string" ? check.kind : undefined,
            cwd: typeof check?.cwd === "string" ? check.cwd : undefined,
            root: row.directory,
          })
          if (!found) return
          yield* store.observe({
            ...found,
            scope: MemoryStore.scope(row),
            sessionID: event.data.sessionID,
            seq: event.durable?.seq,
          })
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("memory: could not record a passed check", cause))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* events.subscribe(SessionEvent.Prompted).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.data.completion) return
          const sentences = standingInstructions(event.data.prompt.text)
          if (sentences.length === 0) return
          const row = yield* session(event.data.sessionID)
          // A subtask's prompt was written by a model, not by the user.
          if (!row || row.parent) return
          yield* Effect.forEach(sentences, (sentence) =>
            store.observe({
              scope: MemoryStore.scope(row),
              kind: "preference",
              key: `said:${Hash.fast(sentence.toLowerCase().replace(/\s+/g, " "))}`,
              text: sentence,
              verification: MemoryStore.said,
              sessionID: event.data.sessionID,
              seq: event.durable?.seq,
              settled: true,
            }),
          )
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("memory: could not record an instruction", cause))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

export const node = makeGlobalNode({
  name: "memory-recorder",
  layer,
  deps: [Database.node, EventV2.node, MemoryStore.node],
})
