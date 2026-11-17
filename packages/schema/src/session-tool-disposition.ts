export * as SessionToolDisposition from "./session-tool-disposition"

import { Option, Schema } from "effect"
import { SessionID } from "./session-id"
import { NonNegativeInt, optional } from "./schema"

const MessageID = Schema.String.check(Schema.isStartsWith("msg_"))

export const Info = Schema.Struct({
  version: Schema.Literal(1),
  sessionID: SessionID,
  turnID: MessageID,
  assistantMessageID: MessageID,
  callID: Schema.String,
  basisSeq: NonNegativeInt,
  status: Schema.Literals(["recovered", "exploratory", "failed", "interrupted", "unknown"]),
  reason: Schema.Literals([
    "invalidated",
    "incomplete",
    "unverified",
    "same-operation",
    "exploratory-miss",
    "no-changes",
    "tool-error",
    "verification",
    "uncertain",
    "interrupted",
  ]),
  evidence: Schema.Struct({
    assistantMessageID: MessageID,
    callID: Schema.String,
    settledSeq: NonNegativeInt,
  }).pipe(optional),
}).annotate({ identifier: "Session.ToolDisposition" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

// Preserve future stored reports without granting them display authority.
export const Stored = Schema.Union([Info, Schema.Record(Schema.String, Schema.Unknown)])

export function read(value: unknown) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(Info)(value))
}
