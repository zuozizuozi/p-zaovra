export * as Memory from "./memory"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { optional, statics } from "./schema"
import { SessionID } from "./session-id"

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
  time: Schema.Struct({
    created: Schema.Finite,
    updated: Schema.Finite,
    observed: Schema.Finite,
  }),
}).annotate({ identifier: "Memory.Note" })
export interface Note extends Schema.Schema.Type<typeof Note> {}

/** One earlier conversation that matched a search, with the passages that matched. */
export const SessionMatch = Schema.Struct({
  sessionID: SessionID,
  title: Schema.String,
  time: Schema.Finite,
  passages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
}).annotate({ identifier: "Memory.SessionMatch" })
export interface SessionMatch extends Schema.Schema.Type<typeof SessionMatch> {}
