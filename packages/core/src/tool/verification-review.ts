export * as VerificationReviewTool from "./verification-review"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@zaovra-ai/llm"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { executions, historicalEvidence, history, requested, toolChecks } from "../session/outcome"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"
import { Tool } from "./tool"

export const name = "verification_review"
export const Input = Schema.Struct({
  items: Schema.optional(SessionOutcome.Review.fields.items),
  unverified: Schema.optional(SessionOutcome.Review.fields.unverified),
  notes: SessionOutcome.Review.fields.notes,
})
const Output = Schema.Struct({
  requirements: Schema.Array(Schema.Struct({ id: Schema.Number, text: Schema.String })),
  checks: Schema.Array(Schema.Struct({ callID: Schema.String, command: Schema.String, exit: Schema.Number })),
  problems: Schema.Array(Schema.String),
  executions: Schema.Array(
    Schema.Struct({
      callID: Schema.String,
      tool: Schema.String,
      order: Schema.Number,
      command: Schema.String,
      exit: Schema.optional(Schema.Number),
      started: Schema.optional(Schema.Number),
      completed: Schema.optional(Schema.Number),
    }),
  ),
  review: Schema.optional(SessionOutcome.Review),
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const database = yield* Database.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Record final requirement review; does not run commands or certify semantic correctness. Call {} for numbered ORIGINAL clauses, check callIDs and historical executions. Submit items for EVERY clause: requirement=id, status=verified or unverified, evidence=[current passing check callIDs], note=what is asserted or missing. Default kind=result requires current passing evidence. Use kind=process ONLY for a clause about actions or execution order, with history=[{callID, exit, before?: later executed tool callID}]; observed nonzero exits are valid historical facts, not proof of a working product. Mixed process/function clauses need current evidence too. Never reclassify functionality as process to bypass checks. Log/event IDs are not callIDs. Put unmet or uncertain USER requirements and narrowed interpretations in unverified and mark affected items unverified. Optional notes=[{text, requirements:[]}] is for supplementary context: verified behavior, resolved historical errors, or extra facts outside requested scope such as unrequested platform coverage. Its requirement IDs identify related clauses, NOT a gap; use [] for unrelated context. Never hide unmet requirements in notes. Notes cannot replace any original clause or waive failures; uncertain scope belongs in unverified. Do not demand unrequested features merely to achieve completion. Rerun affected checks after repairs and update this review. An earlier failed command that has been correctly reverified is history, not a remaining gap.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const messages = yield* history(database.db, context.sessionID)
              const request = requested(messages)
              const observed = executions(messages)
              const checks = messages.flatMap((message) =>
                message.type === "assistant"
                  ? message.content.flatMap((part) => (part.type === "tool" ? toolChecks(part) : []))
                  : [],
              )
              return {
                requirements: request.clauses.map((text, index) => ({ id: index + 1, text })),
                checks: checks.map((check) => ({ callID: check.callID, command: check.command, exit: check.exit })),
                executions: observed,
                problems: (input.items ?? []).flatMap((item) => [
                  ...(item.history ?? []).flatMap((reference) => {
                    return !historicalEvidence(reference, observed)
                      ? [
                          `Requirement ${item.requirement}: invalid historical execution ${reference.callID}; use the observed callID, exit and execution order returned in executions.`,
                        ]
                      : []
                  }),
                  ...item.evidence
                    .filter((id) => !checks.some((check) => check.callID === id))
                    .map(
                      (id) =>
                        `Requirement ${item.requirement}: ${id} is not a verification check callID. Log/event IDs are not check IDs. Use the callID values returned in checks; keep historical observations in note. This is a reference error, not proof that the requirement failed.`,
                    ),
                ]),
                ...(input.items && request.userMessageID
                  ? {
                      review: {
                        userMessageID: request.userMessageID,
                        items: input.items,
                        ...(input.notes ? { notes: input.notes } : {}),
                        unverified: input.unverified ?? [
                          "Review did not declare remaining scope; submit unverified explicitly",
                        ],
                      },
                    }
                  : {}),
              }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/verification-review",
  layer,
  deps: [ToolRegistry.node, Database.node, PermissionV2.node],
})
