export * as VerificationReviewTool from "./verification-review"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@zaovra-ai/llm"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { Database } from "../database/database"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import {
  checkFreshness,
  checkReferenceProblem,
  derive,
  executions,
  fingerprint,
  historicalEvidenceProblem,
  historyCandidates,
  history,
  requested,
  toolChecks,
} from "../session/outcome"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"
import { Tool } from "./tool"
import { DeliveryAudit } from "../session/delivery-audit"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Snapshot } from "../snapshot"

export const name = "verification_review"
export const Input = Schema.Struct({
  items: Schema.optional(SessionOutcome.Review.fields.items),
  unverified: Schema.optional(SessionOutcome.Review.fields.unverified),
  notes: SessionOutcome.Review.fields.notes,
})
const Output = Schema.Struct({
  artifacts: Schema.Array(DeliveryAudit.Observation),
  requirements: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      text: Schema.String,
      sourceMessageID: Schema.String,
      withdrawnBy: Schema.optional(Schema.String),
    }),
  ),
  checks: Schema.Array(
    Schema.Struct({
      callID: Schema.String,
      command: Schema.String,
      exit: Schema.Number,
      fresh: Schema.Boolean,
      changedTargets: Schema.Array(Schema.String),
      snapshotBased: Schema.Boolean,
      supersededBy: Schema.optional(Schema.String),
      targets: Schema.Array(Schema.String),
    }),
  ),
  problems: Schema.Array(Schema.String),
  historyCandidates: Schema.Array(Schema.Struct({ callID: Schema.String, exit: Schema.Number })),
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
    const config = yield* Config.Service
    if (Config.latest(yield* config.entries(), "experimental")?.verification === false) return
    const tools = yield* Tools.Service
    const database = yield* Database.Service
    const permission = yield* PermissionV2.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const snapshots = yield* Snapshot.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "For history, copy a {callID, exit} entry from historyCandidates exactly; these are the only eligible references in the current request. executions also lists other tools solely for optional before ordering; do not use review/edit/read calls as history evidence. The host validates exit and ordering. Reference corrections do not require rerunning passing checks. " +
            "Checks include host-computed fresh and changedTargets. Reuse current passing checks and their requirement mappings; rerun only checks whose dependencies changed. An artifact observation changing requires an updated review, not automatically a new code test. A declared check target remains a dependency even if it is documentation; never drop it retroactively to salvage stale evidence. " +
            "Requirement sourceMessageID identifies the user's original wording. Entries with withdrawnBy were explicitly withdrawn by that user message; keep their IDs reserved but do not demand those deliverables. Other conflicts must remain explained and unverified. Host artifacts are file observations, not semantic proof. Repair reported missing artifacts, then update the review. " +
            "Record final requirement review; does not run commands or certify semantic correctness. Call {} for numbered ORIGINAL clauses, check callIDs and historical executions. Submit items for EVERY active clause (without withdrawnBy): requirement=id, status=verified or unverified, evidence=[current passing check callIDs], note=what is asserted or missing. Default kind=result requires current passing evidence. Use kind=process ONLY for a clause about actions or execution order, with history=[{callID, exit, before?: later executed tool callID}]; observed nonzero exits are valid historical facts, not proof of a working product. Mixed process/function clauses need current evidence too. Never reclassify functionality as process to bypass checks. Log/event IDs are not callIDs. Put unmet or uncertain USER requirements and narrowed interpretations in unverified and mark affected items unverified. Optional notes=[{text, requirements:[]}] is for supplementary context: verified behavior, resolved historical errors, or extra facts outside requested scope such as unrequested platform coverage. Its requirement IDs identify related clauses, NOT a gap; use [] for unrelated context. Never hide unmet requirements in notes. Notes cannot replace any original clause or waive failures; uncertain scope belongs in unverified. Do not demand unrequested features merely to achieve completion. Rerun affected checks after repairs and update this review. An earlier failed command that has been correctly reverified is history, not a remaining gap.",
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
              const artifacts = yield* DeliveryAudit.inspect(fs, location.directory, request.entries)
              const checks = messages.flatMap((message) =>
                message.type === "assistant"
                  ? message.content.flatMap((part) => (part.type === "tool" ? toolChecks(part) : []))
                  : [],
              )
              const targets = yield* fingerprint(
                fs,
                checks.flatMap((check) => (check.targets ?? []).map((target) => target.path)),
              )
              const snapshot = checks.some((check) => !check.targets?.length) ? yield* snapshots.capture() : undefined
              const retained = derive(messages, false, snapshot, targets, [], undefined, location.directory).checks
              const current = retained.map((check) => ({
                callID: check.callID,
                command: check.command,
                exit: check.exit,
                ...(check.supersededBy ? { supersededBy: check.supersededBy } : {}),
                targets: (check.targets ?? []).map((target) => target.path),
                ...checkFreshness(check, targets, snapshot),
              }))
              return {
                artifacts,
                requirements: request.entries,
                checks: current,
                executions: observed,
                historyCandidates: historyCandidates(observed),
                problems: [
                  ...(input.items
                    ? request.entries
                        .filter(
                          (entry) => !entry.withdrawnBy && !input.items?.some((item) => item.requirement === entry.id),
                        )
                        .map(
                          (entry) =>
                            `Requirement ${entry.id}: missing review item; use the host requirement IDs returned here, not a new numbering.`,
                        )
                    : []),
                  ...(input.items ?? []).flatMap((item, index, items) => [
                    ...(!request.entries.some((entry) => entry.id === item.requirement && !entry.withdrawnBy)
                      ? [
                          `Requirement ${item.requirement}: unknown or withdrawn requirement ID; correct the review mapping without rerunning unaffected checks.`,
                        ]
                      : []),
                    ...(items.findIndex((entry) => entry.requirement === item.requirement) !== index
                      ? [`Requirement ${item.requirement}: duplicate review item.`]
                      : []),
                  ]),
                  ...artifacts
                    .filter((item) => item.problem)
                    .map(
                      (item) =>
                        `Requirement ${item.requirement}: ${item.path}: ${item.problem}; repair the requested artifact and update this review.`,
                    ),
                  ...(input.items ?? []).flatMap((item) => [
                    ...item.evidence.flatMap((id) => {
                      const problem = checkReferenceProblem(id, messages, retained, targets, snapshot)
                      return problem ? [`Requirement ${item.requirement}: ${problem}`] : []
                    }),
                    ...(item.history ?? []).flatMap((reference) => {
                      const problem = historicalEvidenceProblem(reference, observed)
                      return problem
                        ? [
                            `Requirement ${item.requirement}: invalid historical execution ${reference.callID}: ${problem}. Copy an eligible reference from historyCandidates; correct this review without rerunning unaffected checks.`,
                          ]
                        : []
                    }),
                  ]),
                ],
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
  deps: [Config.node, ToolRegistry.node, Database.node, PermissionV2.node, FSUtil.node, Location.node, Snapshot.node],
})
