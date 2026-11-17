export * as ToolDisposition from "./tool-disposition"

import { SessionToolDisposition } from "@zaovra-ai/schema/session-tool-disposition"
import { SessionRequest } from "@zaovra-ai/schema/session-request"
import { SessionMessage } from "./message"
import { SessionOutcome } from "./outcome"
import { and, asc, desc, eq, lte, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessageTable } from "./sql"

type Tool = { part: SessionMessage.AssistantTool; message: SessionMessage.Assistant }

const terminal = new Set<string>([
  "session.next.step.ended",
  "session.next.step.failed",
  "session.next.text.ended",
  "session.next.tool.success",
  "session.next.tool.failed",
  "session.next.shell.ended",
  "session.next.revert.cleared",
  "session.next.revert.committed",
  "session.next.prompted",
  "session.next.context.updated",
])

/** Live, newly committed sources only. Replay projects saved reports and never produces another. */
export function listen(db: Database.Interface["db"], events: EventV2.Interface) {
  return events.listen(
    (event) => {
      if (!event.durable || !terminal.has(event.type) || !Schema.is(SessionEvent.All)(event)) return Effect.void
      return Effect.gen(function* () {
        const reports = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const failed = sql`exists (select 1 from json_each(${SessionMessageTable.data}, '$.content') tool where json_extract(tool.value, '$.type') = 'tool' and json_extract(tool.value, '$.state.status') = 'error')`
              const turn = sql<string | null>`json_extract(${SessionMessageTable.data}, '$.turn')`
              const session = eq(SessionMessageTable.session_id, event.data.sessionID)
              const owner =
                "assistantMessageID" in event.data
                  ? eq(SessionMessageTable.id, event.data.assistantMessageID)
                  : "messageID" in event.data
                    ? eq(SessionMessageTable.id, event.data.messageID)
                    : event.type === "session.next.shell.ended"
                      ? and(
                          eq(SessionMessageTable.type, "shell"),
                          sql`json_extract(${SessionMessageTable.data}, '$.callID') = ${event.data.callID}`,
                        )
                      : undefined
              const targets = event.type.startsWith("session.next.revert.")
                ? yield* tx
                    .selectDistinct({ turn })
                    .from(SessionMessageTable)
                    .where(and(session, eq(SessionMessageTable.type, "assistant"), failed))
                    .all()
                : owner
                  ? yield* tx
                      .select({ turn })
                      .from(SessionMessageTable)
                      .where(and(session, owner))
                      .orderBy(desc(SessionMessageTable.seq))
                      .limit(1)
                      .all()
                  : []
              return yield* Effect.flatMap(
                Effect.forEach(targets, ({ turn: target }) =>
                  Effect.gen(function* () {
                    if (!target) return []
                    const related = and(session, sql`${turn} = ${target}`)
                    // Select only an ID on the ordinary no-error path: no history or message JSON decoding.
                    if (
                      !(yield* tx
                        .select({ id: SessionMessageTable.id })
                        .from(SessionMessageTable)
                        .where(and(related, eq(SessionMessageTable.type, "assistant"), failed))
                        .limit(1)
                        .get())
                    )
                      return []
                    const last = yield* tx
                      .select({
                        completed: sql<number | null>`json_extract(${SessionMessageTable.data}, '$.time.completed')`,
                        finish: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.finish')`,
                      })
                      .from(SessionMessageTable)
                      .where(and(related, eq(SessionMessageTable.type, "assistant")))
                      .orderBy(desc(SessionMessageTable.seq))
                      .limit(1)
                      .get()
                    if (last?.completed == null || !last.finish || last.finish === "tool-calls") return []
                    const request = yield* tx
                      .select({ seq: SessionMessageTable.seq })
                      .from(SessionMessageTable)
                      .where(
                        and(
                          session,
                          eq(SessionMessageTable.type, "user"),
                          eq(SessionMessageTable.id, SessionMessage.ID.make(target)),
                        ),
                      )
                      .get()
                    if (!request || request.seq < 0) return []
                    const rows = yield* tx
                      .select()
                      .from(SessionMessageTable)
                      .where(
                        and(
                          session,
                          or(
                            sql`${turn} = ${target}`,
                            and(eq(SessionMessageTable.type, "user"), lte(SessionMessageTable.seq, request.seq)),
                          ),
                        ),
                      )
                      .orderBy(asc(SessionMessageTable.seq))
                      .all()
                    const history = rows.map((row) =>
                      Schema.decodeUnknownSync(SessionMessage.Message)({
                        ...row.data,
                        id: row.id,
                        type: row.type,
                        seq: row.seq,
                      }),
                    )
                    return classify(event.data.sessionID, history).filter((report) => {
                      const message = history.find((item) => item.id === report.assistantMessageID)
                      const tool =
                        message?.type === "assistant"
                          ? message.content.find((part) => part.type === "tool" && part.id === report.callID)
                          : undefined
                      return tool?.type === "tool" && JSON.stringify(tool.failureDisposition) !== JSON.stringify(report)
                    })
                  }),
                ),
                (groups) => Effect.succeed(groups.flat()),
              )
            }),
          )
          .pipe(Effect.orDie)
        if (!reports.length) return
        yield* events.publish(SessionEvent.Tool.Disposition, {
          sessionID: event.data.sessionID,
          timestamp: event.data.timestamp,
          reports,
        })
      })
    },
    { replay: false },
  )
}

/** Receives authoritative, sequence-ordered persisted history, never a UI page. */
export function classify(sessionID: string, history: readonly SessionMessage.Message[]) {
  return history.flatMap((message) => {
    if (message.type !== "assistant") return []
    return message.content.flatMap((part): SessionToolDisposition.Info[] => {
      if (part.type !== "tool" || part.state.status !== "error") return []
      const current = SessionToolDisposition.read(part.failureDisposition)
      if (
        !current ||
        current.sessionID !== sessionID ||
        current.assistantMessageID !== message.id ||
        current.turnID !== message.turn ||
        current.callID !== part.id
      )
        return []
      const result = (
        status: SessionToolDisposition.Info["status"],
        reason: SessionToolDisposition.Info["reason"],
        evidence?: Tool,
      ): SessionToolDisposition.Info[] => [
        {
          ...current,
          status,
          reason,
          ...(evidence && evidence.part.settledSeq !== undefined
            ? {
                evidence: {
                  assistantMessageID: evidence.message.id,
                  callID: evidence.part.id,
                  settledSeq: evidence.part.settledSeq,
                },
              }
            : {}),
        },
      ]
      const turn = history.filter(
        (item): item is SessionMessage.Assistant => item.type === "assistant" && item.turn === message.turn,
      )
      const last = turn.at(-1)
      const tools = turn.flatMap((owner) =>
        owner.content.flatMap((item): Tool[] => (item.type === "tool" ? [{ part: item, message: owner }] : [])),
      )
      if (
        (message.seq ?? -1) < 0 ||
        part.settledSeq === undefined ||
        !message.turn ||
        !history.some((item) => item.type === "user" && item.id === message.turn)
      )
        return result("unknown", "unverified")
      if (
        part.provider?.executed ||
        message.content.filter((item) => item.type === "tool" && item.id === part.id).length !== 1
      )
        return result("unknown", "unverified")
      if (
        !last?.time.completed ||
        !last.finish ||
        last.finish === "tool-calls" ||
        tools.some((item) => ["pending", "running"].includes(item.part.state.status))
      )
        return result("unknown", "incomplete")
      if (
        part.settlement === "interrupted" &&
        message.termination?.category === "interrupted" &&
        message.termination.source === "user" &&
        /^(?:Error:\s*)?Tool execution interrupted[.!]?$/i.test(part.state.error.message.trim())
      )
        return result("interrupted", "interrupted")
      if (verification(part)) return result("failed", "verification")
      if (uncertain(part)) return result("failed", "uncertain")
      const ordinary =
        !last.error && last.finish === "stop" && last.content.some((item) => item.type === "text" && item.text.trim())
      if (part.name === "edit" && /^\s*(?:Error:\s*)?No changes to apply:/i.test(part.state.error.message))
        return ordinary ? result("exploratory", "no-changes") : result("failed", "tool-error")
      const later = tools.filter(
        (item) =>
          item.message.agent === message.agent &&
          (item.message.seq ?? -1) >= 0 &&
          (item.part.settledSeq ?? -1) > part.settledSeq! &&
          clean(item.part),
      )
      const same = later.find((item) => sameOperation(part, item.part))
      if (same && part.name !== "read") return result("recovered", "same-operation", same)
      if (!ordinary || !exploratory(part)) return result("failed", "tool-error")
      // An unresolved mutation, permission or verification failure bars an outcome-neutral label.
      if (
        tools.some((item) =>
          item.part.state.status === "completed"
            ? !clean(item.part)
            : item.part.state.status === "error" &&
              !exploratory(item.part) &&
              !neutral(item.part) &&
              !tools.some(
                (next) =>
                  next.message.agent === item.message.agent &&
                  clean(next.part) &&
                  (next.part.settledSeq ?? -1) > (item.part.settledSeq ?? Infinity) &&
                  !verification(item.part) &&
                  !uncertain(item.part) &&
                  sameOperation(item.part, next.part),
              ),
        )
      )
        return result("failed", "tool-error")
      const prefix = history.slice(0, history.findIndex((item) => item.id === message.turn) + 1)
      const requested = SessionRequest.requested(prefix, () => "")
      const scope = prefix
        .slice(prefix.findIndex((item) => item.id === requested.sourceMessageID))
        .filter((item): item is SessionMessage.User => item.type === "user")
      const complete =
        scope.length > 0 &&
        scope.every(
          (item) =>
            (item.seq ?? -1) >= 0 && item.text.trim() && !item.files?.length && !item.agents?.length && !item.subtask,
        ) &&
        SessionRequest.continuationText(scope[0]!.text) === undefined &&
        !/^(?:补充要求|追加要求|修改要求)\s*[。.!！]*$/u.test(scope[0]!.text.trim())
      if (!complete) return result("unknown", "unverified")
      if (same && part.name === "read") return result("recovered", "same-operation", same)
      const target = input(part).path ?? input(part).filePath
      const filename = typeof target === "string" ? target.split(/[\\/]/).at(-1)?.trim().toLowerCase() : undefined
      const sources = new Set(requested.entries.map((item) => item.sourceMessageID))
      const unrequested =
        filename &&
        filename !== "." &&
        filename !== ".." &&
        !scope
          .filter((item) => sources.has(item.id))
          .some((item) =>
            [item.text, typeof item.invocation === "string" ? item.invocation : ""].some((text) =>
              text.replaceAll("\\", "/").toLowerCase().includes(filename),
            ),
          )
      const alternative = later.find(
        (item) =>
          part.name !== "read" ||
          ((item.part.name === "read" || (item.part.name === "write" && unrequested)) &&
            typeof target === "string" &&
            target &&
            target === (input(item.part).path ?? input(item.part).filePath)),
      )
      return alternative ? result("exploratory", "exploratory-miss", alternative) : result("failed", "tool-error")
    })
  })
}

function input(part: SessionMessage.AssistantTool) {
  return part.state.status === "pending" ? {} : part.state.input
}

function metadata(part: SessionMessage.AssistantTool) {
  return part.state.status === "pending"
    ? {}
    : {
        ...(part.state.status === "error" ? part.state.error.metadata : undefined),
        ...part.state.structured,
      }
}

function verification(part: SessionMessage.AssistantTool) {
  const value = metadata(part)
  return !!(
    input(part).verification ||
    input(part).verification_report ||
    value.verification ||
    value.verifications ||
    value.phase === "verification" ||
    (part.state.status === "error" && /\bVerification failed\b/i.test(part.state.error.message))
  )
}

function uncertain(part: SessionMessage.AssistantTool) {
  const value = metadata(part)
  return !!(
    value.timeout ||
    value.job_id ||
    (value.phase === "mutation" && value.reason !== "match-failed") ||
    (part.state.status === "error" &&
      /\bOutcome may have occurred\b|\btimeout\b|\btimed out\b|\bpartial|\bpermission denied\b|\baccess denied\b|\bEACCES\b|\bEPERM\b/i.test(
        part.state.error.message,
      ))
  )
}

function clean(part: SessionMessage.AssistantTool) {
  if (part.state.status !== "completed" || part.provider?.executed || uncertain(part)) return false
  const value = metadata(part)
  if (typeof value.exit === "number" && value.exit !== 0) return false
  if (verification(part) && (value.exit !== 0 || value.execution)) return false
  if (SessionOutcome.toolChecks(part).some((check) => check.exit !== 0 || check.execution)) return false
  return ![value, ...(Array.isArray(value.applied) ? value.applied : [])].some((item) => {
    if (!item || typeof item !== "object") return false
    return ["formatting", "lsp"].some((key) => {
      const report = (item as Record<string, unknown>)[key]
      return (
        report &&
        typeof report === "object" &&
        "failed" in report &&
        Array.isArray(report.failed) &&
        report.failed.length > 0
      )
    })
  })
}

function neutral(part: SessionMessage.AssistantTool) {
  return (
    part.name === "edit" &&
    part.state.status === "error" &&
    !verification(part) &&
    !uncertain(part) &&
    /^\s*(?:Error:\s*)?No changes to apply:/i.test(part.state.error.message)
  )
}

function exploratory(part: SessionMessage.AssistantTool) {
  return (
    part.state.status === "error" &&
    !verification(part) &&
    !uncertain(part) &&
    (part.name === "read"
      ? metadata(part).readFailure === "not_found"
      : ["list", "glob", "grep", "websearch"].includes(part.name) &&
        /\b(?:ENOENT|file not found|no such file|does not exist|no (?:results|matches)(?: found)?)\b/i.test(
          part.state.error.message,
        ))
  )
}

function sameOperation(failed: SessionMessage.AssistantTool, success: SessionMessage.AssistantTool) {
  if (verification(success)) return false
  const before = input(failed)
  const after = input(success)
  if (failed.name === "edit")
    return (
      success.name === "edit" &&
      typeof (before.filePath ?? before.path) === "string" &&
      (before.filePath ?? before.path) === (after.filePath ?? after.path) &&
      typeof before.newString === "string" &&
      before.newString.length > 0 &&
      before.newString === after.newString &&
      (before.replaceAll === true) === (after.replaceAll === true) &&
      typeof before.oldString === "string" &&
      typeof after.oldString === "string" &&
      before.oldString.trim().replace(/\s+/g, " ") === after.oldString.trim().replace(/\s+/g, " ")
    )
  return (
    failed.name === success.name &&
    Object.keys(before).length > 0 &&
    Object.keys(before).length === Object.keys(after).length &&
    Object.keys(before).every((key) => JSON.stringify(before[key]) === JSON.stringify(after[key]))
  )
}
