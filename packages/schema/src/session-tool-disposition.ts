export * as SessionToolDisposition from "./session-tool-disposition"

import { Option, Schema } from "effect"
import { SessionID } from "./session-id"
import { NonNegativeInt, optional } from "./schema"

const MessageID = Schema.String.check(Schema.isStartsWith("msg_"))

// Historical events must still replay when an individual report contradicts its evidence.
export const Wire = Schema.Struct({
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
export const Info = Wire.check(
  Schema.makeFilter((report) => {
    const evidence = report.evidence
    if (
      evidence &&
      (!evidence.callID.trim() ||
        evidence.settledSeq > report.basisSeq ||
        (evidence.callID === report.callID && evidence.assistantMessageID === report.assistantMessageID))
    )
      return false
    switch (report.reason) {
      case "same-operation":
        return report.status === "recovered" && !!evidence
      case "exploratory-miss":
        return report.status === "exploratory" && !!evidence
      case "no-changes":
        return report.status === "exploratory" && !evidence
      case "interrupted":
        return report.status === "interrupted" && !evidence
      case "verification":
      case "uncertain":
      case "tool-error":
        return report.status === "failed" && !evidence
      default:
        return report.status === "unknown" && !evidence
    }
  }),
)
export interface Info extends Schema.Schema.Type<typeof Info> {}

// Preserve future stored reports without granting them display authority.
export const Stored = Schema.Union([Wire, Schema.Record(Schema.String, Schema.Unknown)])

export function read(value: unknown, failedSeq?: number) {
  const report = Option.getOrUndefined(Schema.decodeUnknownOption(Info)(value))
  if (report?.evidence && failedSeq !== undefined && report.evidence.settledSeq <= failedSeq) return
  return report
}
