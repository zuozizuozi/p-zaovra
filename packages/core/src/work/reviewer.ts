export * as WorkReviewer from "./reviewer"

import { Work } from "@zaovra-ai/schema/work"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionV2 } from "../session"
import { SessionMessage } from "../session/message"
import { SessionRunner } from "../session/runner"
import { SessionOutcome } from "../session/outcome"
import { Hash } from "../util/hash"

export type Input = {
  readonly goal: Work.GoalInfo
  readonly task: Work.TaskInfo
  readonly attempt: Work.AttemptInfo
  readonly criteria: ReadonlyArray<Work.Criterion>
  readonly evidence: ReadonlyArray<Work.EvidenceInfo>
  readonly handoffs: ReadonlyArray<Work.HandoffInfo>
}

export class InvalidOutputError extends Schema.TaggedErrorClass<InvalidOutputError>()("WorkReviewer.InvalidOutput", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly run: (
    input: Input,
  ) => Effect.Effect<Work.ReviewOutput, InvalidOutputError | SessionV2.Error | SessionRunner.RunError>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkReviewer") {}

const ReviewJson = Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Work.ReviewOutput))
const decode = Schema.decodeUnknownEffect(ReviewJson)

export const parse = Effect.fn("WorkReviewer.parse")(function* (text: string) {
  const normalized = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
  return yield* decode(normalized).pipe(
    Effect.mapError(() => new InvalidOutputError({ message: "Reviewer did not return valid structured JSON" })),
  )
})

export function evidenceID(attemptID: Work.AttemptID) {
  return Work.EvidenceID.make(`evidence_${hash(`review:${attemptID}`)}`)
}

export function evaluationID(attemptID: Work.AttemptID, criterionID: Work.CriterionID) {
  return Work.EvaluationID.make(`evaluation_${hash(`${attemptID}:${criterionID}:review:1`)}`)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service

    return Service.of({
      run: Effect.fn("WorkReviewer.run")(function* (input) {
        const sessionID = input.attempt.sessionID
        if (!sessionID) return yield* new InvalidOutputError({ message: "Reviewer Attempt has no Session" })
        yield* sessions.prompt({
          id: promptID(input.attempt.id),
          sessionID,
          prompt: { text: prompt(input) },
          resume: false,
        })
        yield* sessions.resume(sessionID)
        const messages = yield* sessions.messages({ sessionID, limit: 20, order: "desc" })
        const response = messages.find((message) => message.type === "assistant")
        if (!response || response.type !== "assistant")
          return yield* new InvalidOutputError({ message: "Reviewer Session produced no assistant response" })
        const text = response.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n")
        if (!text) return yield* new InvalidOutputError({ message: "Reviewer response contained no text" })
        return yield* parse(text)
      }),
    })
  }),
)

function promptID(attemptID: Work.AttemptID) {
  return SessionMessage.ID.make(`msg_${attemptID.slice("attempt_".length)}`)
}

export function prompt(input: Input) {
  return [
    `Goal: ${input.goal.objective}`,
    `Task: ${input.task.title}\n${input.task.instructions}`,
    `Review these criteria:\n${input.criteria.map((criterion) => `- ${criterion.id}: ${criterion.description}`).join("\n")}`,
    `Deterministic evidence:\n${JSON.stringify(
      input.evidence.slice(-20).map((evidence) => ({
        id: evidence.id,
        criterionIDs: evidence.criterionIDs,
        kind: evidence.kind,
        producer: evidence.producer,
        payload: summarizePayload(evidence.payload),
        digest: evidence.digest,
        reference: evidence.reference,
      })),
    )}`,
    "Host check evidence is an observation, not a criterion verdict. Only eligiblePass=true supports a passed command; failed, stale, superseded or unexecuted checks never do. Missing evidence is unverified. Upstream handoffs are historical claims and must be checked against current artifacts. Review only assigned criteria; do not require global plans or other Tasks’ deliverables for local acceptance.",
    `Upstream Handoffs:\n${JSON.stringify(
      input.handoffs.map((handoff) => ({
        id: handoff.id,
        taskID: handoff.taskID,
        producer: handoff.producer,
        summary: handoff.summary,
        items: handoff.items,
        evidenceIDs: handoff.evidenceIDs,
        digest: handoff.digest,
      })),
    )}`,
    `Return JSON with this exact shape: {"criteria":[{"criterionID":"criterion_...","verdict":"pass|fail|blocked","findings":[{"code":"optional","message":"...","severity":"info|warning|error","location":"optional","taskID":"responsible business task ID for final acceptance failures"}],"allowsRepair":true}]}`,
  ].join("\n\n")
}

/** Source is host-projected tool output, never assistant prose or provider-executed claims. */
export function sessionEvidence(input: {
  goal: Work.GoalInfo
  task: Work.TaskInfo
  attempt: Work.AttemptInfo
  source?: Work.AttemptInfo
  messages: ReadonlyArray<SessionMessage.Message>
  targets: ReadonlyArray<{ path: string; digest: string }>
  snapshot?: string
  timestamp: DateTime.Utc
}) {
  if (
    !input.source?.sessionID ||
    input.source.taskID !== input.task.id ||
    input.source.status !== "succeeded" ||
    !["execute", "repair"].includes(input.source.kind) ||
    !input.task.criteria.length
  )
    return undefined
  const outcome = SessionOutcome.derive(input.messages, false, input.snapshot, input.targets)
  const checks = input.messages.flatMap((message) =>
    message.type !== "assistant"
      ? []
      : message.content.flatMap((part) =>
          part.type !== "tool"
            ? []
            : SessionOutcome.toolChecks(part).map((check) => {
                const current = outcome.checks.find((item) => item.callID === check.callID && item.kind === check.kind)
                const fresh =
                  SessionOutcome.checkFreshness(check, input.targets, input.snapshot).fresh &&
                  (check.assertions ?? []).every(
                    (assertion) =>
                      !!assertion.digest &&
                      input.targets.some(
                        (target) => target.path === assertion.path && target.digest === assertion.digest,
                      ),
                  )
                return {
                  ...check,
                  messageID: message.id,
                  fresh,
                  supersededBy: current?.supersededBy ?? null,
                  eligiblePass:
                    check.exit === 0 &&
                    !check.execution &&
                    fresh &&
                    !!current &&
                    !current.supersededBy &&
                    outcome.state !== "failed" &&
                    !outcome.outcomeUnknown &&
                    !outcome.missing.some((item) => item.startsWith("Failed assertion")),
                }
              }),
        ),
  )
  if (!checks.length) return undefined
  return Work.EvidenceInfo.make({
    id: Work.EvidenceID.make(`evidence_${hash(`${input.attempt.id}:session-checks`)}`),
    goalID: input.goal.id,
    taskID: input.task.id,
    attemptID: input.attempt.id,
    criterionIDs: input.task.criteria,
    kind: "command",
    producer: "session-host/1",
    payload: JSON.parse(
      JSON.stringify({
        sessionID: input.source.sessionID,
        sourceAttemptID: input.source.id,
        snapshot: input.snapshot,
        checks,
        missing: outcome.missing,
      }),
    ),
    digest: hash(JSON.stringify(checks)),
    reference: input.source.sessionID,
    createdAt: input.timestamp,
  })
}

function summarizePayload(payload: Work.EvidenceInfo["payload"]) {
  if (!isRecord(payload)) return payload
  if (typeof payload.output !== "string" || payload.output.length <= 12_000) return payload
  return { ...payload, output: `${payload.output.slice(0, 12_000)}\n[review prompt truncated]` }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hash(value: string) {
  return Hash.sha256(value)
}

export const node = makeGlobalNode({ service: Service, layer, deps: [SessionV2.node] })
