export * as WorkExecutionLocal from "./execution-local"

import { Effect, FiberSet, Layer, Schedule } from "effect"
import { Work } from "@zaovra-ai/schema/work"
import { makeGlobalNode } from "../effect/app-node"
import { SessionV2 } from "../session"
import { SessionRunCoordinator } from "../session/run-coordinator"
import { TaskTool } from "../tool/task"
import { WorkController } from "./controller"
import { WorkExecution } from "./execution"
import { WorkRecovery } from "./recovery"
import { WorkRunner } from "./runner"
import { WorkStore } from "./store"

const layer = Layer.effect(
  WorkExecution.Service,
  Effect.gen(function* () {
    const controllers = yield* WorkController.Service
    const runner = yield* WorkRunner.Service
    const recovery = yield* WorkRecovery.Service
    const sessions = yield* SessionV2.Service
    const store = yield* WorkStore.Service
    const coordinator = yield* SessionRunCoordinator.make<Work.GoalID, never>({
      drain: (goalID, force) => runner.run({ goalID, force }),
    })
    const running = new Set<Work.GoalID>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const interrupt = Effect.fn("WorkExecution.interruptLocal")(function* (goalID: Work.GoalID) {
      const tasks = yield* store.tasks(goalID)
      const attempts = yield* Effect.forEach(tasks, (task) => store.attempts(task.id))
      const sessionIDs = attempts
        .flat()
        .filter((attempt) => attempt.status === "admitted" || attempt.status === "running")
        .flatMap((attempt) => (attempt.sessionID ? [attempt.sessionID] : []))
      yield* Effect.forEach(sessionIDs, sessions.interrupt, { discard: true })
      yield* coordinator.interrupt(goalID)
    })

    const execute = Effect.fn("WorkExecution.executeDispatch")(function* (claim: WorkController.Claim) {
      if (running.has(claim.goalID)) return
      running.add(claim.goalID)
      yield* controllers
        .run(
          claim,
          recovery
            .recover(claim.goalID)
            .pipe(Effect.andThen(claim.signal === "interrupt" ? Effect.void : coordinator.run(claim.goalID))),
        )
        .pipe(
          Effect.catchTag("WorkController.Lost", (error) =>
            Effect.logWarning("Work dispatch ownership lost; stopping stale controller", {
              goalID: error.goalID,
              controllerID: error.controllerID,
              runtimeID: error.runtimeID,
              fence: error.fence,
            }),
          ),
          Effect.ensuring(Effect.sync(() => running.delete(claim.goalID))),
        )
    })

    const dispatch = Effect.fn("WorkExecution.dispatch")(function* (goalID?: Work.GoalID) {
      for (const claim of yield* controllers.claim({ goalID, limit: goalID ? 1 : 8 })) fork(execute(claim))
    })

    yield* Effect.gen(function* () {
      for (const goalID of yield* controllers.interrupts) yield* interrupt(goalID)
      yield* dispatch()
    }).pipe(Effect.repeat(Schedule.spaced("250 millis")), Effect.forkScoped)

    return WorkExecution.Service.of({
      active: Effect.all([coordinator.active, controllers.activeGoals]).pipe(
        Effect.map(([local, cluster]) => new Set([...local, ...cluster])),
      ),
      resume: Effect.fn("WorkExecution.resume")(function* (goalID) {
        yield* controllers.signal(goalID, "wake")
        const claim = (yield* controllers.claim({ goalID, limit: 1 }))[0]
        if (claim) yield* execute(claim)
      }),
      wake: Effect.fn("WorkExecution.wake")(function* (goalID) {
        yield* controllers.signal(goalID, "wake")
        yield* dispatch(goalID)
      }),
      interrupt: Effect.fn("WorkExecution.interrupt")(function* (goalID) {
        yield* controllers.signal(goalID, "interrupt")
        yield* interrupt(goalID)
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: WorkExecution.Service,
  layer,
  deps: [SessionV2.node, TaskTool.node, WorkController.node, WorkRecovery.node, WorkRunner.node, WorkStore.node],
})
