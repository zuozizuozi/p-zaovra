export * as SessionExecutionStatus from "./execution-status"

import { Schema } from "effect"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"

/**
 * Orders execution status reports from one or more server processes. `epoch` is the start time of
 * the reporting process and `revision` counts its status changes, so a reader keeps whichever
 * report compares higher and a slow response can never overwrite a newer event.
 */
export const Version = Schema.Struct({ epoch: Schema.Finite, revision: Schema.Int })
export type Version = typeof Version.Type

/**
 * Whether this process is working on the Session right now. Process-local and never replayed: a
 * crashed process cannot announce that it stopped, so readers also ask again when they reconnect.
 */
export const Changed = EventV2.define({
  type: "session.execution.status",
  schema: { sessionID: SessionSchema.ID, active: Schema.Boolean, ...Version.fields },
})
