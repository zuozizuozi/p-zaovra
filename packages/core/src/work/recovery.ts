export * as WorkRecovery from "./recovery"

import { Work } from "@zaovra-ai/schema/work"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { LayerNode } from "../effect/layer-node"
import { EventV2 } from "../event"
import { WorkExecution } from "./execution"
import { WorkIsolation } from "./isolation"
import { WorkLease } from "./lease"
import { WorkProjector } from "./projector"
import { WorkRemoteJob } from "./remote-job"
import { WorkReviewer } from "./reviewer"
import { WorkStateMachine } from "./state-machine"
import { WorkStore } from "./store"

export type Summary = {
  readonly woken: ReadonlyArray<Work.GoalID>
  readonly paused: ReadonlyArray<Work.GoalID>
  readonly cancelled: ReadonlyArray<Work.GoalID>
  readonly recoveredAttempts: ReadonlyArray<Work.AttemptID>
  readonly unknownAttempts: ReadonlyArray<Work.AttemptID>
}

export interface Interface {
  readonly recover: (goalID?: Work.GoalID) => Effect.Effect<Summary>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkRecovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const leases = yield* WorkLease.Service
    const store = yield* WorkStore.Service
    const isolation = yield* WorkIsolation.Service
    const remoteJobs = yield* WorkRemoteJob.Service

    const recover = Effect.fn("WorkRecovery.recover")(function* (goalID?: Work.GoalID) {
      const woken: Work.GoalID[] = []
      const paused: Work.GoalID[] = []
      const cancelled: Work.GoalID[] = []
      const recoveredAttempts: Work.AttemptID[] = []
      const unknownAttempts: Work.AttemptID[] = []
      for (const goal of (yield* store.goals()).filter((goal) => goalID === undefined || goal.id === goalID)) {
        yield* Effect.forEach(
          (yield* store.tasks(goal.id)).filter((task) => task.status === "completed" || task.status === "superseded"),
          (task) => isolation.release(goal, task),
          { concurrency: 4, discard: true },
        )
      }
      for (const goal of (yield* store.goals(["active", "pausing", "cancelling"])).filter(
        (goal) => goalID === undefined || goal.id === goalID,
      )) {
        const action = yield* leases
          .run(goal.id, (claim) =>
            Effect.gen(function* () {
              const tasks = yield* store.tasks(goal.id)
              const attempts = (yield* Effect.forEach(tasks, (task) => store.attempts(task.id))).flat()
              if (goal.status === "cancelling") {
                yield* leases.assert(claim)
                const timestamp = yield* DateTime.now
                for (const attempt of attempts.filter(
                  (attempt) => attempt.status === "admitted" || attempt.status === "running",
                )) {
                  yield* leases.assert(claim)
                  const unknown = attempt.status === "running"
                  yield* events.publish(Work.Event.AttemptSettled, {
                    goalID: goal.id,
                    attemptID: attempt.id,
                    status: unknown ? "unknown" : "cancelled",
                    ownerID: attempt.ownerID,
                    fence: attempt.fence,
                    failure: {
                      kind: unknown ? "unknown" : "cancelled",
                      message: unknown
                        ? "Process ownership was lost while cancellation was pending"
                        : "Goal cancellation was recovered before the Attempt started",
                      retryable: false,
                    },
                    timestamp,
                  })
                  if (unknown) unknownAttempts.push(attempt.id)
                }
                for (const task of tasks) {
                  if (WorkStateMachine.isTaskTerminal(task.status)) continue
                  yield* leases.assert(claim)
                  yield* events.publish(Work.Event.TaskCancelled, {
                    goalID: goal.id,
                    taskID: task.id,
                    status: "cancelled",
                    reason: "Recovered durable Goal cancellation",
                    timestamp,
                  })
                }
                for (const task of yield* store.tasks(goal.id)) {
                  if (task.status !== "cancelled") continue
                  const artifact = yield* isolation.archive(goal, task)
                  if (!artifact) continue
                  yield* events.publish(Work.Event.TaskIsolationArchived, {
                    goalID: goal.id,
                    taskID: task.id,
                    artifact,
                    reason: "cancelled",
                    timestamp,
                  })
                  yield* isolation.release(goal, task)
                }
                yield* leases.assert(claim)
                yield* events.publish(Work.Event.GoalCancelled, {
                  goalID: goal.id,
                  reason: "Recovered durable Goal cancellation",
                  timestamp,
                })
                return "cancelled" as const
              }
              const running = attempts.filter((attempt) => attempt.status === "running")
              if (running.length === 0) {
                if (goal.status === "pausing") {
                  yield* pause(goal.id, claim)
                  return "paused" as const
                }
                return "wake" as const
              }

              const recovered = yield* Effect.forEach(running, (attempt) => recoverAttempt(attempt, claim), {
                concurrency: 1,
              })
              recoveredAttempts.push(...recovered.filter((attemptID) => attemptID !== undefined))
              const unknown = running.filter((attempt, index) => recovered[index] === undefined)
              if (unknown.length === 0) {
                if (goal.status === "pausing") {
                  yield* pause(goal.id, claim)
                  return "paused" as const
                }
                return "wake" as const
              }

              const timestamp = yield* DateTime.now
              for (const attempt of unknown) {
                yield* leases.assert(claim)
                yield* events.publish(Work.Event.AttemptSettled, {
                  goalID: goal.id,
                  attemptID: attempt.id,
                  status: "unknown",
                  ownerID: attempt.ownerID,
                  fence: attempt.fence,
                  failure: {
                    kind: "unknown",
                    message: "Process ownership was lost while the Attempt was running",
                    retryable: false,
                    details: { ownerID: attempt.ownerID ?? null, fence: attempt.fence ?? null },
                  },
                  timestamp,
                })
                unknownAttempts.push(attempt.id)
              }
              for (const task of tasks.filter((task) => unknown.some((attempt) => attempt.taskID === task.id))) {
                if (WorkStateMachine.isTaskTerminal(task.status)) continue
                yield* leases.assert(claim)
                yield* events.publish(Work.Event.TaskBlocked, {
                  goalID: goal.id,
                  taskID: task.id,
                  status: "blocked",
                  reason: "A running Attempt has an unknown post-restart outcome",
                  timestamp,
                })
              }
              yield* leases.assert(claim)
              yield* events.publish(Work.Event.GoalBlocked, {
                goalID: goal.id,
                reason: "Manual recovery is required for an Attempt with unknown side effects",
                timestamp,
              })
              return "blocked" as const
            }),
          )
          .pipe(Effect.catchTag("WorkLease.Lost", () => Effect.succeed(undefined)))
        if (action === "wake") {
          woken.push(goal.id)
        }
        if (action === "paused") paused.push(goal.id)
        if (action === "cancelled") cancelled.push(goal.id)
      }
      return { woken, paused, cancelled, recoveredAttempts, unknownAttempts }
    })

    const pause = Effect.fn("WorkRecovery.pause")(function* (goalID: Work.GoalID, claim: WorkLease.Claim) {
      yield* leases.assert(claim)
      yield* events.publish(Work.Event.GoalPaused, { goalID, timestamp: yield* DateTime.now })
    })

    const recoverReview = Effect.fn("WorkRecovery.recoverReview")(function* (
      attempt: Work.AttemptInfo,
      claim: WorkLease.Claim,
    ) {
      if (attempt.kind !== "review") return undefined
      const evidenceID = WorkReviewer.evidenceID(attempt.id)
      const evidence = (yield* store.evidence(attempt.taskID)).find(
        (item) => item.id === evidenceID && item.attemptID === attempt.id && item.producer === "work-reviewer/1",
      )
      if (!evidence || !Schema.is(Work.ReviewOutput)(evidence.payload)) return undefined

      const timestamp = yield* DateTime.now
      const evaluations = yield* store.evaluations(attempt.taskID)
      for (const result of evidence.payload.criteria) {
        const evaluationID = WorkReviewer.evaluationID(attempt.id, result.criterionID)
        if (evaluations.some((evaluation) => evaluation.id === evaluationID)) continue
        yield* leases.assert(claim)
        yield* events.publish(Work.Event.EvaluationRecorded, {
          goalID: attempt.goalID,
          timestamp,
          info: Work.EvaluationInfo.make({
            id: evaluationID,
            goalID: attempt.goalID,
            taskID: attempt.taskID,
            attemptID: attempt.id,
            criterionID: result.criterionID,
            evidenceIDs: [evidenceID],
            verdict: result.verdict,
            evaluator: "work-reviewer",
            evaluatorVersion: "1",
            findings: result.findings,
            allowsRepair: result.allowsRepair,
            createdAt: timestamp,
          }),
        })
      }
      yield* leases.assert(claim)
      yield* events.publish(Work.Event.AttemptSettled, {
        goalID: attempt.goalID,
        attemptID: attempt.id,
        status: "succeeded",
        ownerID: attempt.ownerID,
        fence: attempt.fence,
        timestamp,
      })
      return attempt.id
    })

    const recoverAttempt = Effect.fn("WorkRecovery.recoverAttempt")(function* (
      attempt: Work.AttemptInfo,
      claim: WorkLease.Claim,
    ) {
      const review = yield* recoverReview(attempt, claim)
      if (review) return review
      if (attempt.kind !== "execute" && attempt.kind !== "repair") return undefined
      const job = (yield* remoteJobs.list(attempt.goalID)).findLast(
        (candidate) =>
          candidate.attemptID === attempt.id &&
          candidate.status === "completed" &&
          candidate.operation.type === "agent" &&
          candidate.result?.type === "agent" &&
          candidate.result.status === "succeeded" &&
          !candidate.result.artifactError,
      )
      if (!job) return undefined
      const timestamp = yield* DateTime.now
      yield* leases.assert(claim)
      yield* events.publish(Work.Event.AttemptSettled, {
        goalID: attempt.goalID,
        attemptID: attempt.id,
        status: "succeeded",
        ownerID: attempt.ownerID,
        fence: attempt.fence,
        timestamp,
      })
      yield* leases.assert(claim)
      yield* events.publish(Work.Event.TaskVerificationStarted, {
        goalID: attempt.goalID,
        taskID: attempt.taskID,
        status: "verifying",
        timestamp,
      })
      return attempt.id
    })

    return Service.of({ recover })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [EventV2.node, WorkIsolation.node, WorkProjector.node, WorkRemoteJob.node, WorkStore.node, WorkLease.node],
})

export const startupNode = LayerNode.make({
  name: "WorkRecovery.startup",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const execution = yield* WorkExecution.Service
      const summary = yield* Service.pipe(Effect.flatMap((service) => service.recover()))
      yield* Effect.forEach(summary.woken, execution.wake, { discard: true })
    }),
  ),
  deps: [node, WorkExecution.node],
})
