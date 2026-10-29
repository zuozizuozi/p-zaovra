import { expect } from "bun:test"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Database } from "@zaovra-ai/core/database/database"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { Work } from "@zaovra-ai/schema/work"
import { WorkController } from "@zaovra-ai/core/work/controller"
import { WorkExecution } from "@zaovra-ai/core/work/execution"
import { WorkExecutionLocal } from "@zaovra-ai/core/work/execution-local"
import { WorkRecovery } from "@zaovra-ai/core/work/recovery"
import { WorkRunner } from "@zaovra-ai/core/work/runner"
import { WorkStore } from "@zaovra-ai/core/work/store"
import { WorkLease } from "@zaovra-ai/core/work/lease"
import { WorkGoalTable, WorkWorkerTable } from "@zaovra-ai/core/work/sql"
import { eq } from "drizzle-orm"
import { Context, Deferred, Effect, Fiber, Layer, Option } from "effect"
import { adjust } from "effect/testing/TestClock"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, WorkStore.node])))

for (const mode of ["direct-wake", "direct-resume", "queued-wake", "leased-wake", "wake-before-continue"] as const)
  it.effect(`426 preserves ${mode} after the previous dispatch loses its waiter`, () =>
    Effect.gen(function* () {
      const fixture = yield* dispatchFixture(`goal_426_${mode}`)
      const started = yield* Deferred.make<void>()
      const cancel = yield* Deferred.make<void>()
      const abandoned = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const polling = yield* Deferred.make<void>()
      const claimed = yield* Deferred.make<void>()
      const resumed = yield* Deferred.make<void>()
      const settled = yield* Deferred.make<void>()
      const forces: boolean[] = []
      const layer = executionLayer(
        {
          ...fixture.controller,
          claim: (options) =>
            (options?.goalID
              ? fixture.controller.claim(options)
              : Deferred.await(polling).pipe(Effect.andThen(fixture.controller.claim(options)))
            ).pipe(
              Effect.tap((claims) =>
                claims.some((claim) => claim.revision > 1) ? Deferred.succeed(claimed, undefined) : Effect.void,
              ),
            ),
          run: (claim, use) =>
            fixture.controller
              .run(
                claim,
                claim.revision === 1
                  ? use.pipe(Effect.raceFirst(Deferred.await(cancel).pipe(Effect.andThen(Effect.interrupt))))
                  : use,
              )
              .pipe(
                Effect.onExit(() =>
                  claim.revision === 1 ? Deferred.succeed(abandoned, undefined) : Deferred.succeed(settled, undefined),
                ),
              ),
        },
        ({ force }) =>
          Effect.gen(function* () {
            forces.push(force)
            if (forces.length === 1) {
              yield* Deferred.succeed(started, undefined)
              return yield* Deferred.await(finish)
            }
            yield* fixture.db
              .update(WorkGoalTable)
              .set({ status: "completed" })
              .where(eq(WorkGoalTable.id, fixture.goalID))
              .run()
              .pipe(Effect.orDie)
            yield* Deferred.succeed(resumed, undefined)
          }),
      )
      yield* Effect.gen(function* () {
        const execution = yield* WorkExecution.Service
        yield* execution.wake(fixture.goalID)
        yield* Deferred.await(started)
        yield* Deferred.succeed(cancel, undefined)
        yield* Deferred.await(abandoned)
        // The old controller waiter has exited, while its coordinator drain is still alive.
        if (mode !== "wake-before-continue")
          yield* fixture.db
            .update(WorkGoalTable)
            .set({ status: "paused" })
            .where(eq(WorkGoalTable.id, fixture.goalID))
            .run()
            .pipe(Effect.orDie)
        if (mode === "leased-wake" || mode === "wake-before-continue") {
          yield* fixture.controller.signal(fixture.goalID, mode === "wake-before-continue" ? "continue" : "wake")
          const held = (yield* fixture.controller.claim({ goalID: fixture.goalID }))[0]!
          expect(held.signal).toBe("wake")
          yield* fixture.controller.setDraining(true)
          if (mode === "wake-before-continue") yield* fixture.controller.signal(fixture.goalID, "continue")
          if (mode === "leased-wake") yield* execution.wake(fixture.goalID)
          yield* fixture.controller.run(held, Effect.void)
          expect(yield* fixture.controller.dispatches(fixture.goalID)).toMatchObject([
            { revision: 3, processedRevision: 2, status: "pending" },
          ])
        }
        if (mode === "queued-wake") {
          yield* fixture.controller.setDraining(true)
          yield* execution.wake(fixture.goalID)
          expect(yield* fixture.controller.dispatches(fixture.goalID)).toMatchObject([
            { revision: 2, status: "pending" },
          ])
        }
        if (mode === "direct-wake") yield* execution.wake(fixture.goalID)
        if (mode === "direct-resume") yield* execution.resume(fixture.goalID).pipe(Effect.forkChild)
        yield* fixture.controller.setDraining(false)
        yield* Deferred.succeed(polling, undefined)
        yield* Deferred.await(claimed)
        // Quiesce the test scheduler while the old drain is held, so the new waiter
        // has entered the coordinator before releasing it, even on the polling path.
        yield* adjust(0)
        yield* Deferred.succeed(finish, undefined)
        const waiting = yield* Deferred.await(resumed).pipe(Effect.timeoutOption("1 second"), Effect.forkChild)
        yield* adjust(1000)
        const result = yield* Fiber.join(waiting)
        expect(Option.isSome(result)).toBe(true)
        yield* Deferred.await(settled)
        expect(forces).toEqual([true, true])
        expect((yield* fixture.controller.dispatches(fixture.goalID))[0].status).toBe("settled")
      }).pipe(
        Effect.ensuring(
          Effect.all([Deferred.succeed(finish, undefined), Deferred.succeed(polling, undefined)], { discard: true }),
        ),
        Effect.provide(layer),
      )
    }).pipe(Effect.timeout("5 seconds")),
  )

it.live("426 ignores a stale pause observation delivered after a new wake starts", () =>
  Effect.gen(function* () {
    const fixture = yield* dispatchFixture("goal_426_stale_pause", "paused")
    const recovery = yield* Deferred.make<void>()
    const releaseRecovery = yield* Deferred.make<void>()
    const observed = yield* Deferred.make<void>()
    const deliver = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const interrupted = yield* Deferred.make<void>()
    const advanced = yield* Deferred.make<void>()
    const settled = yield* Deferred.make<void>()
    const services = yield* Layer.build(
      WorkLease.makeLayer({
        controllerID: fixture.controller.identity.id,
        controllerRuntimeID: fixture.controller.identity.runtimeID,
        requireController: true,
      }),
    )
    const lease = Context.get(services, WorkLease.Service)
    // A real interrupt recovery owns a Goal lease when the poll takes its SQL snapshot.
    yield* lease
      .run(fixture.goalID, () =>
        Deferred.succeed(recovery, undefined).pipe(Effect.andThen(Deferred.await(releaseRecovery))),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(recovery)
    yield* fixture.controller.signal(fixture.goalID, "interrupt")
    const layer = executionLayer(
      {
        ...fixture.controller,
        interrupts: fixture.controller.interrupts.pipe(
          Effect.flatMap((goals) =>
            goals.includes(fixture.goalID)
              ? Deferred.succeed(observed, undefined).pipe(Effect.andThen(Deferred.await(deliver)), Effect.as(goals))
              : Effect.succeed(goals),
          ),
        ),
        claim: (options) =>
          fixture.controller
            .claim(options)
            .pipe(
              Effect.tap(() =>
                options?.goalID
                  ? Effect.void
                  : Deferred.isDone(deliver).pipe(
                      Effect.flatMap((done) => (done ? Deferred.succeed(advanced, undefined) : Effect.void)),
                    ),
              ),
            ),
        run: (claim, use) =>
          fixture.controller.run(claim, use).pipe(Effect.tap(() => Deferred.succeed(settled, undefined))),
      },
      () =>
        Effect.gen(function* () {
          yield* fixture.db
            .update(WorkGoalTable)
            .set({ status: "active" })
            .where(eq(WorkGoalTable.id, fixture.goalID))
            .run()
            .pipe(Effect.orDie)
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(finish)
          yield* fixture.db
            .update(WorkGoalTable)
            .set({ status: "completed" })
            .where(eq(WorkGoalTable.id, fixture.goalID))
            .run()
            .pipe(Effect.orDie)
        }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
    )
    yield* Effect.gen(function* () {
      const execution = yield* WorkExecution.Service
      yield* Deferred.await(observed)
      yield* execution.wake(fixture.goalID)
      yield* Deferred.await(started)
      yield* Deferred.succeed(deliver, undefined)
      yield* Deferred.await(advanced)
      expect(yield* Deferred.isDone(interrupted)).toBe(false)
      yield* Deferred.succeed(finish, undefined)
      yield* Deferred.await(settled)
      const store = yield* WorkStore.Service
      expect((yield* store.getGoal(fixture.goalID))?.status).toBe("completed")
    }).pipe(
      Effect.ensuring(
        Effect.all(
          [
            Deferred.succeed(deliver, undefined),
            Deferred.succeed(finish, undefined),
            Deferred.succeed(releaseRecovery, undefined),
          ],
          { discard: true },
        ),
      ),
      Effect.provide(layer),
    )
  }).pipe(Effect.timeout("5 seconds")),
)

it.effect("426 serializes a new wake behind an interrupt already past its authority check", () =>
  Effect.gen(function* () {
    const fixture = yield* dispatchFixture("goal_426_pause_admission", "paused")
    const ready = yield* Deferred.make<void>()
    const releaseLease = yield* Deferred.make<void>()
    const preparing = yield* Deferred.make<void>()
    const releasePreparation = yield* Deferred.make<void>()
    const accepted = yield* Deferred.make<void>()
    const resumed = yield* Deferred.make<void>()
    const settled = yield* Deferred.make<void>()
    const store = yield* WorkStore.Service
    const services = yield* Layer.build(
      WorkLease.makeLayer({
        controllerID: fixture.controller.identity.id,
        controllerRuntimeID: fixture.controller.identity.runtimeID,
        requireController: true,
      }),
    )
    yield* Context.get(services, WorkLease.Service)
      .run(fixture.goalID, () => Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(releaseLease))))
      .pipe(Effect.forkChild)
    yield* Deferred.await(ready)
    yield* fixture.controller.signal(fixture.goalID, "interrupt")
    const layer = executionLayer(
      {
        ...fixture.controller,
        signal: (goalID, signal) =>
          fixture.controller
            .signal(goalID, signal)
            .pipe(Effect.tap(() => (signal === "wake" ? Deferred.succeed(accepted, undefined) : Effect.void))),
        run: (claim, use) =>
          fixture.controller
            .run(claim, use)
            .pipe(Effect.tap(() => (claim.signal === "wake" ? Deferred.succeed(settled, undefined) : Effect.void))),
      },
      () =>
        Effect.gen(function* () {
          yield* fixture.db
            .update(WorkGoalTable)
            .set({ status: "completed" })
            .where(eq(WorkGoalTable.id, fixture.goalID))
            .run()
            .pipe(Effect.orDie)
          yield* Deferred.succeed(resumed, undefined)
        }),
    ).pipe(
      Layer.provide(
        Layer.succeed(WorkStore.Service, {
          ...store,
          tasks: (goalID) =>
            store
              .tasks(goalID)
              .pipe(
                Effect.tap(() =>
                  Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Deferred.await(releasePreparation))),
                ),
              ),
        }),
      ),
    )
    yield* Effect.gen(function* () {
      const execution = yield* WorkExecution.Service
      yield* Deferred.await(preparing)
      const wake = yield* execution.wake(fixture.goalID).pipe(Effect.forkChild)
      yield* adjust(0)
      expect(yield* Deferred.isDone(accepted)).toBe(false)
      yield* Deferred.succeed(releasePreparation, undefined)
      yield* Fiber.join(wake)
      yield* adjust(250)
      yield* Deferred.await(resumed)
      yield* Deferred.await(settled)
      expect(yield* Deferred.isDone(accepted)).toBe(true)
      expect((yield* store.getGoal(fixture.goalID))?.status).toBe("completed")
    }).pipe(
      Effect.ensuring(
        Effect.all([Deferred.succeed(releasePreparation, undefined), Deferred.succeed(releaseLease, undefined)], {
          discard: true,
        }),
      ),
      Effect.provide(layer),
    )
  }).pipe(Effect.timeout("5 seconds")),
)

function dispatchFixture(id: string, status: Work.GoalStatus = "active") {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const goalID = Work.GoalID.make(id)
    yield* db
      .insert(WorkWorkerTable)
      .values({
        id: Work.WorkerID.make("worker_local"),
        label: "Local Worker",
        capabilities: ["execute"],
        workspace_roots: ["*"],
        time_created: 1,
        time_heartbeat: 1,
        expires_at: Date.now() + 60_000,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkGoalTable)
      .values({
        id: goalID,
        directory: AbsolutePath.make("/project"),
        objective: "Retain explicit wake",
        acceptance_criteria: [],
        status,
        usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
        revision: 0,
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie)
    const services = yield* Layer.build(
      WorkController.makeLayer({
        controllerID: Work.ControllerID.make(`controller_${id}`),
        runtimeID: Work.ControllerRuntimeID.make(`controller_runtime_${id}`),
      }),
    )
    return { db, goalID, controller: Context.get(services, WorkController.Service) }
  })
}

function executionLayer(controller: WorkController.Interface, run: WorkRunner.Interface["run"]) {
  return WorkExecutionLocal.layer.pipe(
    Layer.provide(Layer.succeed(WorkController.Service, controller)),
    Layer.provide(Layer.mock(WorkRunner.Service, { run })),
    Layer.provide(
      Layer.mock(WorkRecovery.Service, {
        recover: () =>
          Effect.succeed({ woken: [], paused: [], cancelled: [], recoveredAttempts: [], unknownAttempts: [] }),
      }),
    ),
    Layer.provide(
      Layer.mock(SessionV2.Service, {
        revert: {
          stage: () => Effect.die("Unexpected Session revert"),
          clear: () => Effect.die("Unexpected Session revert"),
          commit: () => Effect.die("Unexpected Session revert"),
        },
      }),
    ),
  )
}

it.live("executes approval claimed after durable settlement before local cleanup", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const goalID = Work.GoalID.make("goal_dispatch_settlement_race")
    yield* db
      .insert(WorkWorkerTable)
      .values({
        id: Work.WorkerID.make("worker_local"),
        label: "Local Worker",
        capabilities: ["execute"],
        workspace_roots: ["*"],
        time_created: 1,
        time_heartbeat: 1,
        expires_at: Date.now() + 60_000,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkGoalTable)
      .values({
        id: goalID,
        directory: AbsolutePath.make("/project"),
        objective: "Retain late merge approval",
        acceptance_criteria: [],
        status: "active",
        usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
        revision: 0,
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie)
    const settled = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const claimed = yield* Deferred.make<void>()
    const executed = yield* Deferred.make<void>()
    const processed = yield* Deferred.make<void>()
    const forces: boolean[] = []
    const services = yield* Layer.build(
      WorkController.makeLayer({
        controllerID: Work.ControllerID.make("controller_settlement_race"),
        runtimeID: Work.ControllerRuntimeID.make("controller_runtime_settlement_race"),
      }),
    )
    const controller = Context.get(services, WorkController.Service)
    const layer = WorkExecutionLocal.layer.pipe(
      Layer.provide(
        Layer.succeed(WorkController.Service, {
          ...controller,
          claim: (options) =>
            controller
              .claim(options)
              .pipe(
                Effect.tap((claims) =>
                  claims.some((claim) => claim.goalID === goalID && claim.revision === 2)
                    ? Deferred.succeed(claimed, undefined)
                    : Effect.void,
                ),
              ),
          // Hold the old call after the real database settlement, before its caller's cleanup.
          run: (claim, use) =>
            controller
              .run(claim, use)
              .pipe(
                Effect.tap(() =>
                  claim.revision === 1
                    ? Deferred.succeed(settled, undefined).pipe(Effect.andThen(Deferred.await(release)))
                    : Deferred.succeed(processed, undefined),
                ),
              ),
        }),
      ),
      Layer.provide(
        Layer.mock(WorkRunner.Service, {
          run: ({ force }) =>
            Effect.sync(() => forces.push(force)).pipe(
              Effect.andThen(
                Deferred.isDone(settled).pipe(
                  Effect.flatMap((done) =>
                    done ? Deferred.succeed(executed, undefined).pipe(Effect.asVoid) : Effect.void,
                  ),
                ),
              ),
            ),
        }),
      ),
      Layer.provide(Layer.mock(WorkRecovery.Service, {})),
      Layer.provide(
        Layer.mock(SessionV2.Service, {
          revert: {
            stage: () => Effect.die("Unexpected Session revert"),
            clear: () => Effect.die("Unexpected Session revert"),
            commit: () => Effect.die("Unexpected Session revert"),
          },
        }),
      ),
    )
    yield* Effect.gen(function* () {
      yield* WorkExecution.Service
      yield* controller.signal(goalID, "continue")
      yield* Deferred.await(settled)
      expect(yield* controller.dispatches(goalID)).toMatchObject([{ revision: 1, status: "settled" }])
      yield* controller.signal(goalID, "continue")
      yield* Deferred.await(claimed)
      const result = yield* Deferred.await(executed).pipe(Effect.timeoutOption("1 second"))
      // A freshly claimed approval must execute without waiting for the 20-second lease to expire.
      expect(Option.isSome(result)).toBe(true)
      yield* Deferred.await(processed)
      expect(yield* controller.dispatches(goalID)).toMatchObject([
        { revision: 2, processedRevision: 2, status: "settled" },
      ])
      expect(forces).toEqual([false, false])
    }).pipe(Effect.provide(layer), Effect.ensuring(Deferred.succeed(release, undefined)))
  }).pipe(Effect.timeout("5 seconds")),
)
