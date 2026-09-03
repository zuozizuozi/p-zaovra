export * as WorkReviewer from "./reviewer"

import { Work } from "@zaovra-ai/schema/work"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionV2 } from "../session"
import { SessionMessage } from "../session/message"
import { SessionRunner } from "../session/runner"
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
    `Verified upstream Handoffs:\n${JSON.stringify(
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
    `Return JSON with this exact shape: {"criteria":[{"criterionID":"criterion_...","verdict":"pass|fail|blocked","findings":[{"code":"optional","message":"...","severity":"info|warning|error","location":"optional"}],"allowsRepair":true}]}`,
  ].join("\n\n")
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
