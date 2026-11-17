export * as MemoryCheckTool from "./memory-check"

import path from "node:path"
import { createHash } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
import { Memory } from "@zaovra-ai/schema/memory"
import { Config } from "../config"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { Location } from "../location"
import { MemoryFileEvidence } from "../memory/file-evidence"
import { MemoryStore } from "../memory/store"
import { PermissionV2 } from "../permission"
import { ReadPin } from "../read-pin"
import { SessionEvent } from "../session/event"
import { SessionMessageTable, SessionTable } from "../session/sql"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { ToolRegistry } from "./registry"
import { safetyFailure } from "./safety-failure"

const Input = Schema.Struct({
  noteID: Memory.ID,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  layer: Schema.optional(Schema.Literals(["project", "user"])),
})
const Output = Schema.Struct({
  outcome: Schema.Literals(["matched-at-check", "changed", "unknown"]),
  applied: Schema.Boolean,
  checkedFiles: Schema.Int,
  reason: Schema.optional(Schema.String),
})
const Identity = Schema.fromJsonString(
  Schema.Tuple([
    Schema.Literal("windows-file-id"),
    Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/)),
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  ]),
)
const maximum = 51200
const unknown = (reason: string, checkedFiles = 0) => ({
  outcome: "unknown" as const,
  applied: false,
  checkedFiles,
  reason,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const tools = yield* Tools.Service
    const store = yield* MemoryStore.Service
    const permission = yield* PermissionV2.Service
    const location = yield* Location.Service
    const config = yield* Config.Service
    if (Config.latest(yield* config.entries(), "memory")?.enabled !== true) return
    const project = yield* store.scope({ project: location.project.id, directory: location.directory })
    yield* tools
      .register({
        memory_check: Tool.withPermission(
          Tool.make({
            description:
              "Recheck a kept note's host-bound small local files with Read permission. Use the note ID, file revision and layer already returned for that note. Reports only a match at this check, a byte/object difference, or unknown. It does not verify the note's meaning, grant ongoing freshness, or change user wording. Do not retry conflicts automatically.",
            input: Input,
            output: Output,
            execute: (input, context) =>
              Effect.gen(function* () {
                if (
                  !Number.isSafeInteger(input.expectedRevision) ||
                  !(yield* authorized(database, location, input, context))
                )
                  return unknown("The original local tool call and Session could not be verified.")
                const scope = input.layer === "user" ? Memory.Scope.user : project
                const eligible = () =>
                  Effect.gen(function* () {
                    if (
                      Config.latest(yield* config.entries(), "memory")?.enabled !== true ||
                      !(yield* store.canCheckFiles(scope))
                    )
                      return undefined
                    const note = yield* store.get(input.noteID)
                    return note?.scope === scope && note.fileRevision === input.expectedRevision ? note : undefined
                  })
                const note = yield* eligible()
                if (!note) return unknown("Memory is unavailable or its revision changed. No automatic retry.")
                const parsed = MemoryFileEvidence.decode(note.files)
                if (Option.isNone(parsed) || !MemoryFileEvidence.bindings(parsed.value.files))
                  return unknown("No supported host file bindings.")
                const files = parsed.value.files
                if (
                  files.some(
                    (file) =>
                      file.directory !== location.directory ||
                      file.bytes > maximum ||
                      Option.isNone(Schema.decodeUnknownOption(Identity)(file.identity)),
                  )
                )
                  return unknown("Only this Location's small native file bindings can be checked.")
                // No realpath traversal: native component opens refuse junctions/reparse aliases.
                const originals = yield* Effect.forEach(files, (binding) =>
                  openPin(path.join(location.directory, binding.path)).pipe(
                    Effect.map((pin) => ({
                      binding,
                      pin: pin?.kind === "file" && pin.size >= 0n && pin.size <= BigInt(maximum) ? pin : undefined,
                    })),
                  ),
                )
                const resources = originals.filter((item) => item.pin !== undefined).map((item) => item.binding.path)
                // All permission waits finish before ANY stable lock is acquired, including multi-file notes.
                if (resources.length)
                  yield* permission
                    .assert({
                      action: "read",
                      resources,
                      save: ["*"],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                    })
                    .pipe(
                      Effect.mapError(
                        (error) =>
                          safetyFailure(error) ??
                          new Tool.Failure({
                            message: "File check was not authorized.",
                            metadata: { phase: "permission" },
                          }),
                      ),
                    )
                if (!(yield* eligible()) || !(yield* authorized(database, location, input, context)))
                  return unknown("Memory or call authority changed while awaiting permission. No automatic retry.")
                const results = yield* Effect.forEach(originals, (item) =>
                  Effect.gen(function* () {
                    if (!item.pin) return { path: item.binding.path, state: "unknown" as const, checked: false }
                    const stable = yield* openPin(path.join(location.directory, item.binding.path), true)
                    if (
                      !stable ||
                      stable.identity.volume !== item.pin.identity.volume ||
                      stable.identity.file !== item.pin.identity.file
                    )
                      return { path: item.binding.path, state: "unknown" as const, checked: false }
                    // Scope keeps every stable pin through the final CAS. No read occurs before the identity comparison.
                    const bytes = yield* Effect.try({
                      try: () => {
                        if (stable.size < 0n || stable.size > BigInt(maximum)) return undefined
                        const bytes = item.pin!.read(maximum + 1)
                        if (
                          bytes.length > maximum ||
                          BigInt(bytes.length) !== stable.size ||
                          item.pin!.read(1).length !== 0
                        )
                          return undefined
                        return bytes
                      },
                      catch: () =>
                        new Tool.Failure({
                          message: "The authorized file could not be read completely. No check was applied.",
                        }),
                    })
                    if (!bytes) return { path: item.binding.path, state: "unknown" as const, checked: false }
                    const identity = Schema.decodeUnknownSync(Identity)(item.binding.identity)
                    const same =
                      identity[1] === stable.identity.volume &&
                      identity[2] === stable.identity.file &&
                      item.binding.bytes === bytes.length &&
                      item.binding.digest === createHash("sha256").update(bytes).digest("hex")
                    return {
                      path: item.binding.path,
                      state: same ? ("unknown" as const) : ("changed" as const),
                      checked: true,
                    }
                  }),
                )
                const checkedFiles = results.filter((item) => item.checked).length
                if (!(yield* eligible()))
                  return unknown("Memory changed during the check. No automatic retry.", checkedFiles)
                const applied = yield* store.checkFiles({
                  id: input.noteID,
                  scope,
                  expectedRevision: input.expectedRevision,
                  results,
                })
                if (!applied)
                  return unknown("Memory changed before the check could be recorded. No automatic retry.", checkedFiles)
                return {
                  outcome: results.some((item) => item.state === "changed")
                    ? ("changed" as const)
                    : results.every((item) => item.checked)
                      ? ("matched-at-check" as const)
                      : ("unknown" as const),
                  applied,
                  checkedFiles,
                  reason:
                    "Execution-time object/byte evidence only. Persistent evidence stays unknown or retains prior alerts; no ongoing current or Tool.Success receipt is claimed.",
                }
              }).pipe(Effect.scoped),
          }),
          "read",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/memory-check",
  layer,
  deps: [Database.node, ToolRegistry.node, MemoryStore.node, PermissionV2.node, Location.node, Config.node],
})

function openPin(canonical: string, stable = false) {
  return (stable ? ReadPin.acquireStable(canonical) : ReadPin.acquire(canonical)).pipe(
    Effect.catchTag("UnknownError", (error) => {
      const message = error.cause instanceof Error ? error.cause.message : ""
      // Expected filesystem inability is unknown, never an invented missing/current verdict.
      if (
        message === "Read pin refuses reparse points" ||
        message === "Stable read pin requires a file" ||
        /^Read pin relative open: NTSTATUS (c0000034|c000003a|c0000043|c0000022|c0000056|c00000ba|c0000103)$/.test(
          message,
        ) ||
        /^Read pin root: Win32 (2|3|5|32)$/.test(message)
      )
        return Effect.succeed(undefined)
      return Effect.fail(new Tool.Failure({ message: "Native file check failed. No check was applied." }))
    }),
  )
}

function authorized(
  database: Database.Interface,
  location: Location.Interface,
  input: typeof Input.Type,
  context: Tool.Context,
) {
  return Effect.gen(function* () {
    const session = yield* database.db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, context.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (
      !session ||
      session.parent_id ||
      session.directory !== location.directory ||
      session.project_id !== location.project.id ||
      (session.workspace_id ?? undefined) !== location.workspaceID
    )
      return false
    const author = yield* database.db
      .select()
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.id, context.assistantMessageID),
          eq(SessionMessageTable.session_id, context.sessionID),
          eq(SessionMessageTable.type, "assistant"),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!author || !("agent" in author.data) || author.data.agent !== context.agent) return false
    const calls = yield* database.db
      .select()
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, context.sessionID),
          eq(
            EventTable.type,
            EventV2.versionedType(SessionEvent.Tool.Called.type, SessionEvent.Tool.Called.durable?.version ?? 1),
          ),
          sql`json_extract(${EventTable.data}, '$.assistantMessageID') = ${context.assistantMessageID}`,
          sql`json_extract(${EventTable.data}, '$.callID') = ${context.toolCallID}`,
        ),
      )
      .limit(2)
      .all()
      .pipe(Effect.orDie)
    if (calls.length !== 1 || calls[0]!.seq <= 0) return false
    const called = Schema.decodeUnknownOption(SessionEvent.Tool.Called.data)(calls[0]!.data)
    if (Option.isNone(called)) return false
    return (
      called.value.sessionID === context.sessionID &&
      called.value.tool === "memory_check" &&
      !called.value.provider.executed &&
      called.value.input.noteID === input.noteID &&
      called.value.input.expectedRevision === input.expectedRevision &&
      called.value.input.layer === input.layer &&
      Object.keys(called.value.input).every((key) => ["noteID", "expectedRevision", "layer"].includes(key))
    )
  })
}
