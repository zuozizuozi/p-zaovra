import { AgentV2 } from "@zaovra-ai/core/agent"
import { LocationServiceMap } from "@zaovra-ai/core/location-services"
import { PluginV2 } from "@zaovra-ai/core/plugin"
import { PluginInternal } from "@zaovra-ai/core/plugin/internal"
import { Work } from "@zaovra-ai/core/work"
import { WorkArtifact } from "@zaovra-ai/core/work/artifact"
import { WorkOrganization } from "@zaovra-ai/core/work/organization"
import { WorkMemory } from "@zaovra-ai/core/work/memory"
import { WorkPlacement } from "@zaovra-ai/core/work/placement"
import { WorkStore } from "@zaovra-ai/core/work/store"
import { WorkWorker } from "@zaovra-ai/core/work/worker"
import { WorkRole } from "@zaovra-ai/core/work/role"
import { ConflictError, WorkNotFoundError } from "@zaovra-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const WorkHandler = HttpApiBuilder.group(Api, "server.work", (handlers) =>
  Effect.gen(function* () {
    const work = yield* Work.Service
    const artifacts = yield* WorkArtifact.Service
    const locations = yield* LocationServiceMap.Service
    const placement = yield* WorkPlacement.Service
    const store = yield* WorkStore.Service
    const workers = yield* WorkWorker.Service

    const detail = Effect.fn("WorkHandler.detail")(function* (goalID: Work.GoalID) {
      const goal = yield* work
        .get(goalID)
        .pipe(
          Effect.catchTag(
            "Work.NotFoundError",
            (error) => new WorkNotFoundError({ goalID: error.goalID, message: `Goal not found: ${error.goalID}` }),
          ),
        )
      const tasks = yield* store.tasks(goalID)
      const attempts = (yield* Effect.forEach(tasks, (task) => store.attempts(task.id))).flat()
      const evidence = (yield* Effect.forEach(tasks, (task) => store.evidence(task.id))).flat()
      const evaluations = (yield* Effect.forEach(tasks, (task) => store.evaluations(task.id))).flat()
      const handoffs = yield* store.handoffs(goalID)
      return {
        goal,
        tasks,
        attempts,
        evidence,
        evaluations,
        handoffs,
        roles: goal.roleContracts ?? WorkRole.contracts,
        memory: WorkMemory.view(
          yield* store.projectHandoffs(goal.location, 512),
          yield* store.projectMemoryResolutions(goal.location, 512),
        ),
      }
    })

    const notFound = <A, R>(effect: Effect.Effect<A, Work.NotFoundError, R>) =>
      effect.pipe(
        Effect.catchTag(
          "Work.NotFoundError",
          (error) => new WorkNotFoundError({ goalID: error.goalID, message: `Goal not found: ${error.goalID}` }),
        ),
      )

    const placementErrors = <A, R>(
      effect: Effect.Effect<A, WorkPlacement.NotFoundError | WorkPlacement.ConflictError, R>,
    ) =>
      effect.pipe(
        Effect.catchTag(
          "WorkPlacement.NotFound",
          (error) => new WorkNotFoundError({ goalID: error.goalID, message: `Goal not found: ${error.goalID}` }),
        ),
        Effect.catchTag(
          "WorkPlacement.Conflict",
          (error) => new ConflictError({ resource: error.goalID, message: error.message }),
        ),
      )

    return handlers
      .handle(
        "work.list",
        Effect.fn(function* () {
          return { data: Array.from(yield* work.list) }
        }),
      )
      .handle(
        "work.create",
        Effect.fn(function* (ctx) {
          const location = locations.get(ctx.payload.location)
          yield* PluginV2.Service.pipe(
            Effect.flatMap((plugins) => plugins.wait(PluginInternal.agentReadyID)),
            Effect.provide(location),
            Effect.orDie,
          )
          const roleContracts = yield* WorkOrganization.Service.pipe(
            Effect.flatMap((organization) => organization.contracts),
            Effect.provide(location),
            Effect.orDie,
          )
          const agents = yield* AgentV2.Service.pipe(
            Effect.flatMap((service) => service.all()),
            Effect.provide(location),
            Effect.orDie,
          )
          const missing = roleContracts.find((contract) => !agents.some((agent) => agent.id === contract.agentID))
          if (missing)
            return yield* new ConflictError({
              resource: missing.id,
              message: `Role Contract ${missing.id} references unavailable Agent ${missing.agentID}`,
            })
          const created = yield* work
            .create({ ...ctx.payload, roleContracts, workerID: workers.localID })
            .pipe(
              Effect.catchTag(
                "Work.CreateConflictError",
                (error) => new ConflictError({ resource: error.goalID, message: error.message }),
              ),
            )
          return { data: yield* detail(created.goal.id) }
        }),
      )
      .handle(
        "work.get",
        Effect.fn(function* (ctx) {
          return { data: yield* detail(ctx.params.goalID) }
        }),
      )
      .handle(
        "work.expand",
        Effect.fn(function* (ctx) {
          yield* work.expand({ goalID: ctx.params.goalID, tasks: ctx.payload.tasks }).pipe(
            Effect.catchTag(
              "Work.NotFoundError",
              (error) => new WorkNotFoundError({ goalID: error.goalID, message: `Goal not found: ${error.goalID}` }),
            ),
            Effect.catchTag(
              "Work.ExpandConflictError",
              (error) => new ConflictError({ resource: error.goalID, message: error.message }),
            ),
          )
          return { data: yield* detail(ctx.params.goalID) }
        }),
      )
      .handle(
        "work.replan",
        Effect.fn(function* (ctx) {
          yield* work
            .requestReplan({
              goalID: ctx.params.goalID,
              taskID: ctx.payload.taskID,
              reason: ctx.payload.reason,
            })
            .pipe(
              Effect.catchTag(
                "Work.NotFoundError",
                (error) => new WorkNotFoundError({ goalID: error.goalID, message: `Goal not found: ${error.goalID}` }),
              ),
              Effect.catchTag(
                "Work.ReplanConflictError",
                (error) => new ConflictError({ resource: error.taskID, message: error.message }),
              ),
            )
          return { data: yield* detail(ctx.params.goalID) }
        }),
      )
      .handle(
        "work.active",
        Effect.fn(function* () {
          return {
            data: Object.fromEntries(
              Array.from(yield* work.active, (goalID) => [goalID, { type: "running" as const }]),
            ),
          }
        }),
      )
      .handle(
        "work.artifacts",
        Effect.fn(function* () {
          return { data: Array.from(yield* artifacts.inventory) }
        }),
      )
      .handle(
        "work.artifactCollect",
        Effect.fn(function* (ctx) {
          return { data: yield* artifacts.collect(ctx.payload).pipe(Effect.orDie) }
        }),
      )
      .handle(
        "work.resume",
        Effect.fn(function* (ctx) {
          const current = yield* placement
            .info(ctx.params.goalID)
            .pipe(
              Effect.catchTag(
                "WorkPlacement.NotFound",
                (error) => new WorkNotFoundError({ goalID: error.goalID, message: `Goal not found: ${error.goalID}` }),
              ),
            )
          if (!current.workerID && current.lease?.status !== "active")
            yield* placement
              .assign({
                goalID: ctx.params.goalID,
                workerID: workers.localID,
                reason: "Assigned to the local Worker on resume",
              })
              .pipe(placementErrors)
          yield* work.resume(ctx.params.goalID).pipe(
            Effect.catchTag(
              "Work.NotFoundError",
              (error) => new WorkNotFoundError({ goalID: error.goalID, message: `Goal not found: ${error.goalID}` }),
            ),
            Effect.catchTag(
              "Work.ResumeConflictError",
              (error) => new ConflictError({ resource: error.goalID, message: error.message }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "work.pause",
        Effect.fn(function* (ctx) {
          yield* notFound(work.pause(ctx.params.goalID))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "work.cancel",
        Effect.fn(function* (ctx) {
          yield* notFound(work.cancel(ctx.params.goalID, ctx.payload.reason))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "work.resolveUnknown",
        Effect.fn(function* (ctx) {
          yield* work.resolveUnknown(ctx.params.goalID, ctx.params.attemptID, ctx.payload.reason).pipe(
            Effect.catchTag(
              "Work.NotFoundError",
              (error) => new WorkNotFoundError({ goalID: error.goalID, message: `Goal not found: ${error.goalID}` }),
            ),
            Effect.catchTag(
              "Work.ResolveUnknownConflictError",
              (error) => new ConflictError({ resource: error.attemptID, message: error.message }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "work.resolveMemory",
        Effect.fn(function* (ctx) {
          yield* work
            .resolveMemory({
              goalID: ctx.params.goalID,
              key: ctx.payload.key,
              handoffID: ctx.payload.handoffID,
              itemDigest: ctx.payload.itemDigest,
              resolver: "user",
              reason: ctx.payload.reason,
            })
            .pipe(
              Effect.catchTag(
                "Work.NotFoundError",
                (error) => new WorkNotFoundError({ goalID: error.goalID, message: `Goal not found: ${error.goalID}` }),
              ),
              Effect.catchTag(
                "Work.ResolveMemoryConflictError",
                (error) => new ConflictError({ resource: error.key, message: error.message }),
              ),
            )
          return { data: yield* detail(ctx.params.goalID) }
        }),
      )
      .handle(
        "work.updateMemory",
        Effect.fn(function* (ctx) {
          yield* work
            .updateMemory({
              goalID: ctx.params.goalID,
              key: ctx.params.key,
              kind: ctx.payload.kind,
              text: ctx.payload.text,
              reference: ctx.payload.reference,
              resolver: "user",
              reason: ctx.payload.reason,
            })
            .pipe(
              Effect.catchTag(
                "Work.NotFoundError",
                (error) => new WorkNotFoundError({ goalID: error.goalID, message: `Goal not found: ${error.goalID}` }),
              ),
              Effect.catchTag(
                "Work.ResolveMemoryConflictError",
                (error) => new ConflictError({ resource: error.key, message: error.message }),
              ),
            )
          return { data: yield* detail(ctx.params.goalID) }
        }),
      )
      .handle(
        "work.deleteMemory",
        Effect.fn(function* (ctx) {
          yield* work
            .deleteMemory({
              goalID: ctx.params.goalID,
              key: ctx.params.key,
              resolver: "user",
              reason: "Deleted from the WorkGraph project-memory control plane",
            })
            .pipe(
              Effect.catchTag(
                "Work.NotFoundError",
                (error) => new WorkNotFoundError({ goalID: error.goalID, message: `Goal not found: ${error.goalID}` }),
              ),
              Effect.catchTag(
                "Work.ResolveMemoryConflictError",
                (error) => new ConflictError({ resource: error.key, message: error.message }),
              ),
            )
          return { data: yield* detail(ctx.params.goalID) }
        }),
      )
  }),
)
