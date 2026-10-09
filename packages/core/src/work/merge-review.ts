export * as WorkMergeReview from "./merge-review"

import { WorkEvent } from "@zaovra-ai/schema/work-event"
import { Work } from "@zaovra-ai/schema/work"
import { DurableEventManifest } from "@zaovra-ai/schema/durable-event-manifest"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { AppProcess } from "../process"
import { makeGlobalNode } from "../effect/app-node"
import { Hash } from "../util/hash"
import { WorkAcceptance } from "./acceptance"
import { WorkArtifact } from "./artifact"
import { WorkStore } from "./store"
import { WorkController } from "./controller"

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("WorkMergeReview.Conflict", {
  message: Schema.String,
}) {}
const layer = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const events = yield* EventV2.Service
  const store = yield* WorkStore.Service
  const artifacts = yield* WorkArtifact.Service
  const git = yield* Git.Service
  const fs = yield* FSUtil.Service
  const proc = yield* AppProcess.Service
  const controller = yield* WorkController.Service
  const read = Effect.fn("WorkMergeReview.read")(function* (goalID: Work.GoalID, taskID: Work.TaskID) {
    const goal = yield* store.getGoal(goalID)
    const task = yield* store.getTask(taskID)
    if (!goal || !task || task.goalID !== goalID || task.status !== "merging" || goal.status !== "active")
      return yield* new Conflict({ message: "Task is not awaiting a merge in an active Goal" })
    const history: WorkEvent.DurableEvent[] = []
    let cursor = -1
    while (true) {
      const page = yield* EventV2.readAggregate(db, {
        aggregateID: goalID,
        after: cursor,
        limit: 500,
        manifest: DurableEventManifest.WorkDurable,
      })
      history.push(...page.events)
      if (!page.hasMore) break
      cursor = page.events.at(-1)!.durable!.seq
    }
    const prepared = history.findLast(
      (event) => event.type === WorkEvent.TaskMergeStarted.type && event.data.taskID === taskID,
    )
    if (!prepared || prepared.type !== WorkEvent.TaskMergeStarted.type)
      return yield* new Conflict({ message: "Durable merge input is missing" })
    const diff = prepared.data.artifact ? yield* artifacts.get(prepared.data.artifact) : prepared.data.changes
    if (diff === undefined || Hash.sha256(diff) !== prepared.data.digest)
      return yield* new Conflict({ message: "Merge artifact is unavailable or changed" })
    const source = yield* git.repo.discover(task.location!.directory)
    const destination = yield* git.repo.discover(goal.location.directory)
    if (!source || !destination) return yield* new Conflict({ message: "Merge repositories are unavailable" })
    const candidate = yield* git.change.capture({ repository: source, path: task.location!.directory })
    const baseline = yield* WorkAcceptance.fingerprint(fs, proc, goal.location.directory)
    const head = yield* git.history.head(destination)
    const sourceHead = yield* git.history.head(source)
    if (!baseline || !head || !sourceHead) return yield* new Conflict({ message: "Cannot read merge baseline" })
    const token = Hash.sha256(
      JSON.stringify([
        goalID,
        taskID,
        prepared.durable?.seq,
        head,
        baseline,
        sourceHead,
        Hash.sha256(candidate),
        prepared.data.digest,
      ]),
    )
    const decision = history.findLast(
      (event) => event.type === WorkEvent.TaskMergeReviewed.type && event.data.taskID === taskID,
    )
    return {
      taskID,
      token,
      baseline: head,
      digest: prepared.data.digest,
      diff,
      approved:
        candidate === diff &&
        decision?.type === WorkEvent.TaskMergeReviewed.type &&
        decision.data.token === token &&
        decision.data.approved,
      reason:
        candidate !== diff
          ? "Candidate changed after verification; restore the reviewed candidate or request a new task review."
          : undefined,
    }
  })
  return {
    read: (goalID: Work.GoalID, taskID: Work.TaskID) =>
      read(goalID, taskID).pipe(Effect.catch((error) => Effect.fail(new Conflict({ message: error.message })))),
    decide: Effect.fn("WorkMergeReview.decide")(function* (
      goalID: Work.GoalID,
      taskID: Work.TaskID,
      token: string,
      approved: boolean,
    ) {
      const review = yield* read(goalID, taskID).pipe(
        Effect.catch((error) => Effect.fail(new Conflict({ message: error.message }))),
      )
      if (review.token !== token || review.reason)
        return yield* new Conflict({ message: review.reason ?? "Workspace changed; reload the diff before deciding" })
      yield* events.publish(WorkEvent.TaskMergeReviewed, {
        goalID,
        taskID,
        token,
        approved,
        timestamp: yield* DateTime.now,
      })
      if (approved) yield* controller.signal(goalID, "wake")
    }),
  }
})
export class Service extends Context.Service<Service, Effect.Success<typeof layer>>()("@zaovra/WorkMergeReview") {}
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, layer),
  deps: [
    Database.node,
    EventV2.node,
    WorkStore.node,
    WorkArtifact.node,
    Git.node,
    FSUtil.node,
    AppProcess.node,
    WorkController.node,
  ],
})
