export * as WorkPlacement from "./placement"

import { Work } from "@zaovra-ai/schema/work"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { WorkController } from "./controller"
import { WorkLease } from "./lease"
import { WorkProjector } from "./projector"
import { WorkStateMachine } from "./state-machine"
import { WorkStore } from "./store"
import { WorkWorker } from "./worker"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("WorkPlacement.NotFound", {
  goalID: Work.GoalID,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("WorkPlacement.Conflict", {
  goalID: Work.GoalID,
  message: Schema.String,
}) {}

export interface Interface {
  readonly info: (goalID: Work.GoalID) => Effect.Effect<Work.GoalPlacementInfo, NotFoundError>
  readonly assign: (input: {
    readonly goalID: Work.GoalID
    readonly workerID: Work.WorkerID
    readonly reason?: string
  }) => Effect.Effect<Work.GoalPlacementInfo, NotFoundError | ConflictError>
  readonly release: (
    goalID: Work.GoalID,
    reason?: string,
  ) => Effect.Effect<Work.GoalPlacementInfo, NotFoundError | ConflictError>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkPlacement") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const controllers = yield* WorkController.Service
    const leases = yield* WorkLease.Service
    const store = yield* WorkStore.Service
    const workers = yield* WorkWorker.Service

    const requireGoal = Effect.fn("WorkPlacement.requireGoal")(function* (goalID: Work.GoalID) {
      const goal = yield* store.getGoal(goalID)
      if (!goal) return yield* new NotFoundError({ goalID })
      return goal
    })

    const info = Effect.fn("WorkPlacement.info")(function* (goalID: Work.GoalID) {
      const goal = yield* requireGoal(goalID)
      return Work.GoalPlacementInfo.make({
        goalID,
        workerID: goal.workerID,
        worker: goal.workerID ? yield* workers.get(goal.workerID) : undefined,
        lease: yield* leases.inspect(goalID),
        dispatch: (yield* controllers.dispatches(goalID))[0],
      })
    })

    return Service.of({
      info,
      assign: Effect.fn("WorkPlacement.assign")(function* (input) {
        const goal = yield* requireGoal(input.goalID)
        if (goal.workerID === input.workerID) return yield* info(input.goalID)
        if (WorkStateMachine.isGoalTerminal(goal.status))
          return yield* new ConflictError({
            goalID: input.goalID,
            message: `Goal placement cannot change after ${goal.status}`,
          })
        if (input.reason && input.reason.length > 4_000)
          return yield* new ConflictError({
            goalID: input.goalID,
            message: "Goal placement reason cannot exceed 4000 characters",
          })
        const worker = yield* workers.get(input.workerID)
        if (!worker || worker.status === "offline")
          return yield* new ConflictError({
            goalID: input.goalID,
            message: `Worker is unavailable: ${input.workerID}`,
          })
        if (worker.status === "draining" || !worker.capabilities.includes("execute"))
          return yield* new ConflictError({
            goalID: input.goalID,
            message: `Worker cannot accept execution: ${input.workerID}`,
          })
        if (!canAccess(worker, goal.location.directory))
          return yield* new ConflictError({
            goalID: input.goalID,
            message: `Worker ${input.workerID} cannot access ${goal.location.directory}`,
          })
        if ((yield* leases.inspect(input.goalID))?.status === "active")
          return yield* new ConflictError({
            goalID: input.goalID,
            message: "Goal placement cannot change while its ownership lease is active",
          })
        yield* events.publish(Work.Event.GoalPlacementAssigned, {
          goalID: input.goalID,
          workerID: input.workerID,
          reason: input.reason,
          timestamp: yield* DateTime.now,
        })
        return yield* info(input.goalID)
      }),
      release: Effect.fn("WorkPlacement.release")(function* (goalID, reason) {
        const goal = yield* requireGoal(goalID)
        if (!goal.workerID) return yield* info(goalID)
        if (WorkStateMachine.isGoalTerminal(goal.status))
          return yield* new ConflictError({ goalID, message: `Goal placement cannot change after ${goal.status}` })
        if (reason && reason.length > 4_000)
          return yield* new ConflictError({
            goalID,
            message: "Goal placement reason cannot exceed 4000 characters",
          })
        if ((yield* leases.inspect(goalID))?.status === "active")
          return yield* new ConflictError({
            goalID,
            message: "Goal placement cannot be released while its ownership lease is active",
          })
        yield* events.publish(Work.Event.GoalPlacementReleased, {
          goalID,
          workerID: goal.workerID,
          reason,
          timestamp: yield* DateTime.now,
        })
        return yield* info(goalID)
      }),
    })
  }),
)

function canAccess(worker: Work.WorkerInfo, directory: string) {
  if (worker.executionMode === "shared") return worker.workspaceRoots.some((root) => covers(root, directory))
  return worker.locationMappings.some(
    (mapping) =>
      covers(mapping.controllerRoot, directory) &&
      worker.workspaceRoots.some((root) => covers(root, mapping.workerRoot)),
  )
}

function covers(root: string, target: string) {
  if (root === "*") return true
  const normalizedRoot = comparable(root)
  const normalizedTarget = comparable(target)
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`)
}

function comparable(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "")
  return /^[a-z]:/i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [EventV2.node, WorkController.node, WorkLease.node, WorkProjector.node, WorkStore.node, WorkWorker.node],
})
