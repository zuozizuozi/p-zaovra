export * as WorkExecutionLocal from "./execution-local"

import { Effect, FiberSet, Layer, Schedule } from "effect"
import { Work } from "@zaovra-ai/schema/work"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { SessionV2 } from "../session"
import { SessionRunCoordinator } from "../session/run-coordinator"
import { TaskTool } from "../tool/task"
import { WorkController } from "./controller"
import { WorkExecution } from "./execution"
import { WorkRecovery } from "./recovery"
import { WorkRunner } from "./runner"
import { WorkStore } from "./store"

export const layer = Layer.effect(
  WorkExecution.Service,
  Effect.gen(function* () {
    const controllers = yield* WorkController.Service
    const runner = yield* WorkRunner.Service
    const recovery = yield* WorkRecovery.Service
    const sessions = yield* SessionV2.Service
    const store = yield* WorkStore.Service
    const commands = KeyedMutex.makeUnsafe<Work.GoalID>()
    const coordinator = yield* SessionRunCoordinator.make<Work.GoalID, never>({
      drain: (goalID, force) => runner.run({ goalID, force }),
    })
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
      yield* controllers
        .run(
          claim,
          claim.signal === "continue"
            ? coordinator.exclusive(
                claim.goalID,
                store.getGoal(claim.goalID).pipe(
                  // Check at consumption, then retain the runner's non-forcing state
                  // checks under its lease if a pause lands after this read.
                  Effect.flatMap((goal) =>
                    goal?.status === "active" ? runner.run({ goalID: claim.goalID, force: false }) : Effect.void,
                  ),
                ),
              )
            : claim.signal === "interrupt"
              ? recovery.recover(claim.goalID).pipe(Effect.asVoid)
              : coordinator.exclusive(
                  claim.goalID,
                  recovery
                    .recover(claim.goalID)
                    .pipe(Effect.andThen(runner.run({ goalID: claim.goalID, force: true }))),
                ),
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
        )
    })

    const dispatch = Effect.fn("WorkExecution.dispatch")(function* (goalID?: Work.GoalID) {
      for (const claim of yield* controllers.claim({ goalID, limit: goalID ? 1 : 8 })) fork(execute(claim))
    })

    yield* Effect.gen(function* () {
      for (const goalID of yield* controllers.interrupts)
        yield* commands.withLock(goalID)(
          Effect.gen(function* () {
            // The poll's SQL snapshot can predate a later explicit resume.
            // Recheck under the same admission lock before interrupting its owner.
            const current = (yield* controllers.dispatches(goalID))[0]
            if (current?.signal === "interrupt" && current.status !== "settled") yield* interrupt(goalID)
          }),
        )
      yield* dispatch()
    }).pipe(Effect.repeat(Schedule.spaced("250 millis")), Effect.forkScoped)

    return WorkExecution.Service.of({
      active: Effect.all([coordinator.active, controllers.activeGoals]).pipe(
        Effect.map(([local, cluster]) => new Set([...local, ...cluster])),
      ),
      resume: Effect.fn("WorkExecution.resume")(function* (goalID) {
        yield* commands.withLock(goalID)(controllers.signal(goalID, "wake"))
        const claim = (yield* controllers.claim({ goalID, limit: 1 }))[0]
        if (claim) yield* execute(claim)
      }),
      wake: Effect.fn("WorkExecution.wake")(function* (goalID) {
        yield* commands.withLock(goalID)(controllers.signal(goalID, "wake"))
        yield* dispatch(goalID)
      }),
      interrupt: Effect.fn("WorkExecution.interrupt")(
        function* (goalID) {
          yield* controllers.signal(goalID, "interrupt")
          yield* interrupt(goalID)
        },
        (effect, goalID) => commands.withLock(goalID)(effect),
      ),
    })
  }),
)

export const node = makeGlobalNode({
  service: WorkExecution.Service,
  layer,
  deps: [SessionV2.node, TaskTool.node, WorkController.node, WorkRecovery.node, WorkRunner.node, WorkStore.node],
})
