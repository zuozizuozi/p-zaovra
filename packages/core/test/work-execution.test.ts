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
import { WorkGoalTable, WorkWorkerTable } from "@zaovra-ai/core/work/sql"
import { Context, Deferred, Effect, Layer, Option } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, WorkStore.node])))

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
