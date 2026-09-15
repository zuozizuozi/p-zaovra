export * as SessionV2 from "./session"
export * from "./session/schema"

import { DateTime, Effect, Layer, Schema, Context, Stream, Cause, Exit, Deferred } from "effect"
import { SessionOutcome } from "./session/outcome"
import type { Info } from "@zaovra-ai/schema/session-outcome"
import { Config } from "./config"
import { ListAnchor } from "@zaovra-ai/schema/session"
import { and, asc, desc, eq, gt, isNull, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@zaovra-ai/schema/prompt-input"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { AppProcess } from "./process"
import { BackgroundJob } from "./background-job"
import { ToolOutputStore } from "./tool-output-store"
import { Global } from "./global"
import { KeyedMutex } from "./effect/keyed-mutex"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionLive } from "./session/live"
import { SessionExecution } from "./session/execution"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { SessionTurnDiff } from "./session/turn-diff"
import { Revert } from "@zaovra-ai/schema/revert"
import { FSUtil } from "./fs-util"
import { SessionDurable } from "@zaovra-ai/schema/durable-event-manifest"
import { SessionTodo } from "./session/todo"
import { SessionUsage } from "@zaovra-ai/schema/session-usage"
import { SessionUsageQuery } from "./session/usage"

export const RevertState = Revert.State
export type RevertState = Revert.State

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  roots: Schema.Boolean.pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  parentID?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
}

type CompactInput = {
  sessionID: SessionSchema.ID
}

type UpdateInput = {
  sessionID: SessionSchema.ID
  title?: string
  archived?: boolean
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact", "wait", "recover"]),
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type Error = NotFoundError | MessageDecodeError | OperationUnavailableError | PromptConflictError

export interface Interface {
  readonly recover: (input: {
    sessionID: SessionSchema.ID
    messageID: string
    action: "continue" | "retry" | "abandon"
  }) => Effect.Effect<Info, Error>

  readonly outcome: (sessionID: SessionSchema.ID) => Effect.Effect<Info, NotFoundError>

  readonly usage: (sessionID?: SessionSchema.ID) => Effect.Effect<SessionUsage.Summary>
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly update: (input: UpdateInput) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<{ events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean }, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionSchema.ID; agent: string }) => Effect.Effect<void, NotFoundError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError>
  readonly pending: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError>
  readonly pendingInputs: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<ReadonlyArray<SessionInput.Admitted>, NotFoundError>
  readonly cancelInput: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError>
  readonly todos: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<SessionTodo.Info>, NotFoundError>
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly compact: (input: CompactInput) => Effect.Effect<boolean, NotFoundError | SessionRunner.RunError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<Revert.State, NotFoundError | MessageNotFoundError | Snapshot.Error>
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  }
  readonly turnDiff: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<ReadonlyArray<Revert.FileDiff>, NotFoundError | MessageNotFoundError | Snapshot.Error>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/v2/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const live = yield* SessionLive.Service
    const locations = yield* LocationServiceMap.Service
    const appProcess = yield* AppProcess.Service
    const jobs = yield* BackgroundJob.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const shellLocks = KeyedMutex.makeUnsafe<string>()
    const shells = new Map<SessionSchema.ID, Set<{ controller: AbortController; done: Deferred.Deferred<void> }>>()
    const interruptShells = (sessionID: SessionSchema.ID) =>
      Effect.suspend(() =>
        Effect.forEach(
          Array.from(shells.get(sessionID) ?? []),
          (shell) =>
            Effect.sync(() => shell.controller.abort(new Error("Command interrupted"))).pipe(
              Effect.andThen(Deferred.await(shell.done)),
            ),
          { concurrency: "unbounded", discard: true },
        ),
      )
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const result = Service.of({
      usage: (sessionID) => SessionUsageQuery.read(sessionID).pipe(Effect.provideService(Database.Service, database)),
      create: Effect.fn("V2Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const project = yield* projects.resolve(input.location.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const projected = yield* events
          .publish(
            SessionEvent.Created,
            {
              sessionID,
              timestamp: DateTime.makeUnsafe(now),
              projectID: project.id,
              parentID: input.parentID,
              agent: input.agent,
              model: input.model,
              location: input.location,
              subpath: RelativePath.make(
                path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
              ),
              title: `New session - ${new Date(now).toISOString()}`,
              slug: Slug.create(),
              version: InstallationVersion,
            },
            { location: input.location },
          )
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      recover: Effect.fn("V2Session.recover")(function* (input) {
        if (!execution.exclusive) return yield* new OperationUnavailableError({ operation: "recover" })
        let completed: Exit.Exit<Info, Error> | undefined
        yield* execution
          .exclusive(
            input.sessionID,
            Effect.gen(function* () {
              completed = yield* Effect.exit(
                Effect.gen(function* () {
                  yield* result.get(input.sessionID)
                  const messages = yield* store.context(input.sessionID).pipe(Effect.orDie)
                  const previous = SessionOutcome.derive(messages, false)
                  if (
                    previous.messageID !== input.messageID ||
                    (previous.state !== "interrupted" && previous.state !== "failed") ||
                    (yield* jobs.list()).some(
                      (job) => job.status === "running" && job.metadata?.sessionID === input.sessionID,
                    )
                  )
                    return yield* new OperationUnavailableError({ operation: "recover" })
                  if (input.action === "abandon") {
                    for (const pending of yield* SessionInput.pending(db, input.sessionID))
                      yield* result.cancelInput({ sessionID: input.sessionID, messageID: pending.id })
                    yield* result.update({ sessionID: input.sessionID, archived: true })
                    return previous
                  }
                  const user = messages.findLast((message) => message.type === "user")
                  if (!user) return yield* new OperationUnavailableError({ operation: "recover" })
                  const prompt =
                    input.action === "retry"
                      ? Prompt.fromUserMessage(user)
                      : Prompt.make({
                          text: "Continue the existing task. The previous execution was interrupted or failed. Inspect its retained logs and current workspace before any side effect. Do not assume unfinished commands completed, and do not blindly repeat them.",
                        })
                  yield* result.prompt({ sessionID: input.sessionID, prompt, resume: false })
                  return { ...previous, state: "running" as const, outcomeUnknown: previous.outcomeUnknown }
                }),
              )
            }),
          )
          .pipe(Effect.orDie)
        if (!completed) return yield* Effect.die("Recovery did not settle")
        const outcome = yield* completed
        if (input.action !== "abandon") yield* execution.wake(input.sessionID)
        return outcome
      }),
      outcome: Effect.fn("V2Session.outcome")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        const messages = yield* store.context(sessionID).pipe(Effect.orDie)
        const active =
          (yield* execution.active).has(sessionID) ||
          (shells.get(sessionID)?.size ?? 0) > 0 ||
          (yield* jobs.list()).some((job) => job.status === "running" && job.metadata?.sessionID === sessionID)
        const preliminary = SessionOutcome.derive(messages, active)
        if (active) return preliminary
        const required = yield* SessionOutcome.requirements(fs, session.location.directory)
        if (!preliminary.checks.length) return SessionOutcome.derive(messages, false, undefined, [], required)
        const targets = yield* SessionOutcome.fingerprint(
          fs,
          preliminary.checks.flatMap((check) => check.targets?.map((target) => target.path) ?? []),
        )
        const snapshot = yield* Snapshot.Service.use((service) => service.capture()).pipe(
          Effect.provide(locations.get(session.location)),
        )
        const current = yield* store.context(sessionID).pipe(Effect.orDie)
        const running =
          (yield* execution.active).has(sessionID) ||
          (shells.get(sessionID)?.size ?? 0) > 0 ||
          (yield* jobs.list()).some((job) => job.status === "running" && job.metadata?.sessionID === sessionID)
        // A provider turn may settle while the workspace snapshot is being captured.
        const outcome = SessionOutcome.derive(
          current,
          running,
          JSON.stringify(current) === JSON.stringify(messages) ? snapshot : undefined,
          JSON.stringify(current) === JSON.stringify(messages) ? targets : [],
          required,
        )
        const { Evidence } = yield* Effect.promise(() => import("./evidence"))
        return {
          ...outcome,
          checks: outcome.checks.map((check) => ({
            ...check,
            logs: check.logs?.map((file) => (file.startsWith("ev_") ? file : Evidence.reference(sessionID, file))),
          })),
        }
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      update: Effect.fn("V2Session.update")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* events.publish(
          SessionEvent.Updated,
          {
            sessionID: input.sessionID,
            timestamp: yield* DateTime.now,
            title: input.title,
            archived: input.archived,
          },
          { location: session.location },
        )
        return yield* result.get(input.sessionID).pipe(Effect.orDie)
      }),
      remove: Effect.fn("V2Session.remove")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        yield* result.interrupt(sessionID)
        yield* events.publish(
          SessionEvent.Deleted,
          { sessionID, timestamp: yield* DateTime.now },
          { location: session.location },
        )
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.roots) conditions.push(isNull(SessionTable.parent_id))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        const restore = live.capture()
        yield* result.get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return restore(yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode))
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.durable({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(Stream.filter((event): event is SessionEvent.DurableEvent => isDurableSessionEvent(event))),
      history: Effect.fn("V2Session.history")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* EventV2.readAggregate(db, {
          ...input,
          aggregateID: input.sessionID,
          manifest: SessionDurable,
        })
      }),
      prompt: Effect.fn("V2Session.prompt")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* result.get(input.sessionID)
            const prompt = resolvePrompt(input.prompt)
            const messageID = input.id ?? SessionMessage.ID.create()
            const delivery = input.delivery ?? "steer"
            const expected = { sessionID: input.sessionID, messageID, prompt, delivery }
            const admitted = yield* SessionInput.admit(db, events, {
              id: messageID,
              sessionID: input.sessionID,
              prompt,
              delivery,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionInput.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            if (!SessionInput.equivalent(admitted, expected))
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            if (input.resume !== false && admitted.cancelledSeq === undefined) yield* execution.wake(admitted.sessionID)
            return admitted
          }),
        ),
      ),
      pending: Effect.fn("V2Session.pending")(function* (sessionID) {
        yield* result.get(sessionID)
        return (
          (yield* SessionInput.hasPending(db, sessionID, "steer")) ||
          (yield* SessionInput.hasPending(db, sessionID, "queue"))
        )
      }),
      pendingInputs: Effect.fn("V2Session.pendingInputs")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* SessionInput.pending(db, sessionID)
      }),
      cancelInput: Effect.fn("V2Session.cancelInput")(function* (input) {
        yield* result.get(input.sessionID)
        const stored = yield* SessionInput.find(db, input.messageID)
        if (!stored || stored.sessionID !== input.sessionID || stored.promotedSeq !== undefined)
          return yield* new PromptConflictError(input)
        if (stored.cancelledSeq !== undefined) return stored
        yield* events
          .publish(SessionEvent.PromptCancelled, {
            ...input,
            timestamp: yield* DateTime.now,
          })
          .pipe(
            Effect.catchDefect((defect) =>
              defect instanceof SessionInput.LifecycleConflict
                ? SessionInput.find(db, input.messageID).pipe(
                    Effect.flatMap((current) =>
                      current?.sessionID === input.sessionID && current.cancelledSeq !== undefined
                        ? Effect.void
                        : new PromptConflictError(input),
                    ),
                  )
                : Effect.die(defect),
            ),
          )
        const cancelled = yield* SessionInput.find(db, input.messageID)
        if (!cancelled) return yield* new PromptConflictError(input)
        return cancelled
      }),
      todos: Effect.fn("V2Session.todos")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        return yield* SessionTodo.Service.use((todos) => todos.get(sessionID)).pipe(
          Effect.provide(locations.get(session.location)),
        )
      }),
      shell: Effect.fn("V2Session.shell")((input) => {
        const callID = input.id ?? EventV2.ID.create()
        return shellLocks.withLock(callID)(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const session = yield* result.get(input.sessionID)
              const existing = (yield* result.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
                (message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID,
              )
              if (existing && existing.command !== input.command)
                return yield* new OperationUnavailableError({ operation: "shell" })
              if (existing?.time.completed) return
              if (existing) return yield* new OperationUnavailableError({ operation: "shell" })
              const shell = { controller: new AbortController(), done: Deferred.makeUnsafe<void>() }
              const running = shells.get(input.sessionID) ?? new Set()
              running.add(shell)
              shells.set(input.sessionID, running)
              const releaseShell = Effect.sync(() => {
                running.delete(shell)
                if (running.size === 0) shells.delete(input.sessionID)
                Deferred.doneUnsafe(shell.done, Effect.void)
              })
              yield* events
                .publish(
                  SessionEvent.Shell.Started,
                  {
                    sessionID: input.sessionID,
                    messageID: SessionMessage.ID.create(),
                    callID,
                    command: input.command,
                    timestamp: yield* DateTime.now,
                  },
                  { id: callID, location: session.location },
                )
                .pipe(Effect.onError(() => releaseShell))
              let captured = ""
              let truncated = false
              const capture = ToolOutputStore.makeCapture(fs, path.join(global.data, ToolOutputStore.MANAGED_DIRECTORY))
              const entries = yield* Config.Service.use((service) => service.entries()).pipe(
                Effect.provide(locations.get(session.location)),
              )
              yield* restore(
                appProcess.run(
                  AppProcess.shellCommand(input.command, session.location.directory, Config.latest(entries, "shell")),
                  {
                    combineOutput: true,
                    signal: shell.controller.signal,
                    maxOutputBytes: 1024 * 1024,
                    timeout: "10 minutes",
                    onChunk: capture.append,
                    onOutput: (output, lost) =>
                      Effect.sync(() => {
                        captured = output.toString("utf8")
                        truncated = lost
                      }),
                  },
                ),
              ).pipe(
                Effect.onExit((exit) => {
                  const status = Exit.isSuccess(exit)
                    ? exit.value.exitCode === 0
                      ? ""
                      : `Process exited with code ${exit.value.exitCode}.`
                    : shell.controller.signal.aborted || Cause.hasInterrupts(exit.cause)
                      ? "Command interrupted. Its effects may be partial; inspect the workspace before retrying."
                      : `Command failed: ${Cause.pretty(exit.cause)}`
                  return events.publish(
                    SessionEvent.Shell.Ended,
                    {
                      sessionID: input.sessionID,
                      callID,
                      output: [
                        captured,
                        truncated ? "[output capture truncated at the in-memory safety limit]" : "",
                        ...capture.paths().map((file) => `Command log: ${file}`),
                        status,
                      ]
                        .filter(Boolean)
                        .join("\n"),
                      timestamp: DateTime.nowUnsafe(),
                    },
                    { location: session.location },
                  )
                }),
                Effect.ensuring(releaseShell),
                Effect.catchTag("AppProcessError", () => Effect.void),
              )
              if (!shell.controller.signal.aborted && input.resume !== false) yield* execution.wake(input.sessionID)
            }),
          ),
        )
      }),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (
          session.model?.providerID === input.model.providerID &&
          session.model.id === input.model.id &&
          (session.model.variant ?? "default") === (input.model.variant ?? "default")
        )
          return
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: input.model,
        })
      }),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* execution.compact?.(input.sessionID) ?? Effect.succeed(false)
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* execution.wait?.(sessionID) ?? Effect.void
      }),
      active: execution.active,
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(
          execution.interrupt(sessionID).pipe(
            Effect.andThen(
              Effect.all(
                [
                  interruptShells(sessionID),
                  jobs.list().pipe(
                    Effect.flatMap((items) =>
                      Effect.forEach(
                        items.filter(
                          (job) =>
                            job.type === "bash" && job.metadata?.sessionID === sessionID && job.status === "running",
                        ),
                        (job) => jobs.cancel(job.id),
                        { discard: true },
                      ),
                    ),
                  ),
                ],
                {
                  concurrency: "unbounded",
                  discard: true,
                },
              ),
            ),
          ),
        ),
      ),
      turnDiff: Effect.fn("V2Session.turnDiff")(function* (input) {
        const session = yield* result.get(input.sessionID)
        return yield* SessionTurnDiff.diff(input).pipe(
          Effect.provideService(Database.Service, database),
          Effect.provide(locations.get(session.location)),
        )
      }),
      revert: {
        stage: Effect.fn("V2Session.revert.stage")(function* (input) {
          const session = yield* result.get(input.sessionID)
          return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        clear: Effect.fn("V2Session.revert.clear")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.clear(session).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        commit: Effect.fn("V2Session.revert.commit")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
        }),
      },
    })

    return result
  }),
)

const resolvePrompt = (input: PromptInput.Prompt) =>
  Prompt.make({
    text: input.text,
    invocation: input.invocation,
    agents: input.agents,
    selection: input.selection,
    subtask: input.subtask,
    files: input.files?.map((file) => {
      const dataMime = file.uri.match(/^data:([^;,]+)[;,]/i)?.[1]
      const target = URL.canParse(file.uri) ? new URL(file.uri).pathname : (file.name ?? file.uri)
      return {
        ...file,
        mime: dataMime ?? (target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target)),
      }
    }),
  })

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Database.node,
    AppProcess.node,
    BackgroundJob.node,
    FSUtil.node,
    Global.node,
    EventV2.node,
    ProjectV2.node,
    SessionExecution.node,
    SessionStore.node,
    SessionLive.node,
    LocationServiceMap.node,
    SessionProjector.node,
  ],
})
