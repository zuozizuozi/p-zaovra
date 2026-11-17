export * as SessionExecutionStatus from "./session-execution-status"

import { Schema } from "effect"
import { Event } from "./event"
import { Session } from "./session"

/** Orders live reports against snapshots from the same execution process. */
export const Version = Schema.Struct({ epoch: Schema.Finite, revision: Schema.Int }).annotate({
  identifier: "SessionExecutionStatus.Version",
})
export interface Version extends Schema.Schema.Type<typeof Version> {}

// Current-client wire contract. Runtime coordinator ownership stays in Core.
// Never durable: reconnecting clients must ask for a fresh execution snapshot.
export const Changed = Event.define({
  type: "session.execution.status",
  schema: { sessionID: Session.ID, active: Schema.Boolean, ...Version.fields },
})

export const Definitions = Event.inventory(Changed)
