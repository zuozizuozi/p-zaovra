export * as Memory from "./memory"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { NonNegativeInt, PositiveInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"
import { Model } from "./model"

export const ID = Schema.String.pipe(
  Schema.brand("Memory.ID"),
  statics((schema) => ({ create: () => schema.make("mem_" + ascending()) })),
)
export type ID = typeof ID.Type

/**
 * Whose notes these are: one project, one folder that is not a repository, or `user` for the
 * layer that follows the user across projects. The host derives it; clients never build one.
 */
export const Scope = Schema.String.pipe(
  Schema.brand("Memory.Scope"),
  statics((schema) => ({ user: schema.make("user") })),
)
export type Scope = typeof Scope.Type

export const Kind = Schema.Literals(["practice", "convention", "pitfall", "preference", "decision"])
export type Kind = typeof Kind.Type

/** Who wrote the note. Only `program` and `user` notes carry facts the host observed itself. */
export const Origin = Schema.Literals(["program", "model", "user", "consolidation"])
export type Origin = typeof Origin.Type

/** `stale` marks a note the workspace has since contradicted; it stays searchable but leaves the index. */
export const Status = Schema.Literals(["verified", "unverified", "stale"])
export type Status = typeof Status.Type

/** Storage contract only. Host producers and filesystem authorization are separate. */
export const FileBinding = Schema.Struct({
  path: Schema.NonEmptyString,
  directory: Schema.NonEmptyString,
  identity: Schema.NonEmptyString,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bytes: NonNegativeInt,
  sessionID: SessionID,
  seq: PositiveInt,
})
export type FileBinding = typeof FileBinding.Type

export const FileLinks = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Array(FileBinding).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  state: Schema.Literals(["unknown", "current", "changed", "missing"]),
  checkedAt: Schema.Finite.pipe(optional),
})
export type FileLinks = typeof FileLinks.Type

export const Note = Schema.Struct({
  id: ID,
  scope: Scope,
  kind: Kind,
  text: Schema.String,
  origin: Origin,
  status: Status,
  /** How the note was established, in words a person can check: a command and its exit code, or the user's own words. */
  verification: Schema.String.pipe(optional),
  /** Where it came from, so a reader can open the original record. */
  sessionID: SessionID.pipe(optional),
  seq: Schema.Int.pipe(optional),
  /** How many separate times the host observed the same fact. */
  hits: Schema.Int,
  /** CAS token for file checks; legacy notes start at zero. */
  fileRevision: NonNegativeInt.pipe(optional),
  /** Preserve unknown future versions as data; never interpret their paths. */
  files: Schema.Json.pipe(optional),
  time: Schema.Struct({
    created: Schema.Finite,
    updated: Schema.Finite,
    observed: Schema.Finite,
  }),
}).annotate({ identifier: "Memory.Note" })
export interface Note extends Schema.Schema.Type<typeof Note> {}

export const PageID = Schema.String.pipe(
  Schema.brand("Memory.PageID"),
  statics((schema) => ({ create: () => schema.make("mpg_" + ascending()) })),
)
export type PageID = typeof PageID.Type

/** The host captures the note and its exact content; a model cannot attest its own sources. */
export const PageSource = Schema.Struct({
  id: ID,
  digest: Schema.String,
  sessionID: SessionID.pipe(optional),
  seq: Schema.Int.pipe(optional),
}).annotate({ identifier: "Memory.PageSource" })
export interface PageSource extends Schema.Schema.Type<typeof PageSource> {}

export const Page = Schema.Struct({
  id: PageID,
  scope: Scope,
  title: Schema.String,
  summary: Schema.String,
  body: Schema.String,
  sources: Schema.Array(PageSource),
  revision: Schema.String,
  origin: Schema.Literals(["consolidation", "user"]),
  /** Current means sources still match, not that a model's summary is an instruction. */
  status: Schema.Literals(["current", "stale"]),
  time: Schema.Struct({ created: Schema.Finite, updated: Schema.Finite }),
}).annotate({ identifier: "Memory.Page" })
export interface Page extends Schema.Schema.Type<typeof Page> {}

/** One earlier conversation that matched a search, with the passages that matched. */
export const SessionMatch = Schema.Struct({
  sessionID: SessionID,
  title: Schema.String,
  time: Schema.Finite,
  passages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
}).annotate({ identifier: "Memory.SessionMatch" })
export interface SessionMatch extends Schema.Schema.Type<typeof SessionMatch> {}

/** Explicitly viewed legacy material is never automatically added to model context. */
export const Recovery = Schema.Struct({
  scope: Scope,
  legacyScope: Scope.pipe(optional),
  directory: Schema.String,
  frozen: Schema.Boolean,
  automaticFrozen: Schema.Boolean,
  state: Schema.Literals(["none", "pending", "restored", "blank"]),
  deleted: Schema.Int,
  notes: Schema.Array(
    Schema.Struct({
      note: Note,
      sourceDirectory: Schema.String.pipe(optional),
      restorable: Schema.Boolean,
      restored: Schema.Boolean,
      reason: Schema.String,
    }),
  ),
}).annotate({ identifier: "Memory.Recovery" })
export interface Recovery extends Schema.Schema.Type<typeof Recovery> {}

export const RecoveryChoice = Schema.Struct({
  decision: Schema.Literals(["restore", "blank"]),
  ids: Schema.Array(ID),
}).annotate({ identifier: "Memory.RecoveryChoice" })
export interface RecoveryChoice extends Schema.Schema.Type<typeof RecoveryChoice> {}

/** An explicit, idempotent confirmation. Admission alone never starts model work. */
export const TidyRequest = Schema.Struct({
  requestID: Schema.String,
  layer: Schema.Literals(["project", "user"]).pipe(optional),
  model: Model.Ref,
  tokens: PositiveInt.pipe(optional),
  dailyTokens: PositiveInt.pipe(optional),
}).annotate({ identifier: "Memory.TidyRequest" })
export interface TidyRequest extends Schema.Schema.Type<typeof TidyRequest> {}

export const TidyTask = Schema.Struct({
  id: Schema.String,
  requestID: Schema.String,
  sessionID: SessionID,
  layer: Schema.Literals(["project", "user"]),
  directory: Schema.String,
  model: Model.Ref,
  tokens: PositiveInt,
  dailyTokens: PositiveInt,
  state: Schema.Literals(["active", "completed", "cancelled", "failed"]),
  // Active durable tasks can be ready or paused; opening this view never resumes them.
  executing: Schema.Boolean,
  usage: Schema.Struct({
    known: NonNegativeInt,
    reserved: NonNegativeInt,
    charged: NonNegativeInt,
    unknown: NonNegativeInt,
  }),
  time: Schema.Struct({ created: Schema.Finite, finished: Schema.NullOr(Schema.Finite) }),
}).annotate({ identifier: "Memory.TidyTask" })
export interface TidyTask extends Schema.Schema.Type<typeof TidyTask> {}

/** Separate, persistent consent for automatic project tidy work. */
export const AutomaticConfirmation = Schema.Struct({
  requestID: Schema.String,
  expected: Schema.String.pipe(optional),
  model: Model.Ref,
  tokens: PositiveInt,
  dailyTokens: PositiveInt,
}).annotate({ identifier: "Memory.AutomaticConfirmation" })
export interface AutomaticConfirmation extends Schema.Schema.Type<typeof AutomaticConfirmation> {}

export const AutomaticPreference = Schema.Struct({
  directory: Schema.String,
  generation: Schema.String,
  enabled: Schema.Boolean,
  model: Model.Ref,
  tokens: PositiveInt,
  dailyTokens: PositiveInt,
  currentRun: Schema.NullOr(Schema.String),
  confirmedAt: Schema.Finite,
}).annotate({ identifier: "Memory.AutomaticPreference" })
export interface AutomaticPreference extends Schema.Schema.Type<typeof AutomaticPreference> {}
