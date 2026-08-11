export * as WorkIsolation from "./isolation"

import { Work } from "@zaovra-ai/schema/work"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Git } from "../git"
import { WorkArtifact } from "./artifact"

export interface Interface {
  readonly archive: (goal: Work.GoalInfo, task: Work.TaskInfo) => Effect.Effect<Work.ArtifactReference | undefined>
  readonly release: (goal: Work.GoalInfo, task: Work.TaskInfo) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkIsolation") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const artifacts = yield* WorkArtifact.Service

    const linked = Effect.fnUntraced(function* (directory: Work.TaskInfo["location"]) {
      if (!directory) return undefined
      const repository = yield* git.repo.discover(directory.directory)
      if (!repository) return undefined
      const entry = (yield* git.worktree.list(repository)).find((item) => item.directory === directory.directory)
      return entry?.kind === "linked" ? repository : undefined
    })

    const archive = Effect.fn("WorkIsolation.archive")(function* (goal: Work.GoalInfo, task: Work.TaskInfo) {
      if (!task.location || task.location.directory === goal.location.directory) return undefined
      return yield* Effect.gen(function* () {
        const repository = yield* linked(task.location)
        if (!repository) return undefined
        const changes = yield* git.change.capture({ repository, path: task.location!.directory })
        if (new TextEncoder().encode(changes).byteLength > 64 * 1024 * 1024) return undefined
        const artifact = yield* artifacts.put(changes)
        yield* artifacts.retain(artifact, { type: "task-isolation", id: `${goal.id}:${task.id}` })
        return artifact
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("WorkGraph isolation archive failed", cause).pipe(
            Effect.annotateLogs({ goalID: goal.id, taskID: task.id, directory: task.location?.directory }),
            Effect.as(undefined),
          ),
        ),
      )
    })

    const release = Effect.fn("WorkIsolation.release")(function* (goal: Work.GoalInfo, task: Work.TaskInfo) {
      if (!task.location || task.location.directory === goal.location.directory) return false
      return yield* Effect.gen(function* () {
        const repository = yield* linked(task.location)
        if (!repository) return false
        yield* git.worktree.remove({
          repository,
          directory: task.location!.directory,
          force: true,
        })
        return true
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("WorkGraph isolation cleanup failed", cause).pipe(
            Effect.annotateLogs({ goalID: goal.id, taskID: task.id, directory: task.location?.directory }),
            Effect.as(false),
          ),
        ),
      )
    })

    return Service.of({ archive, release })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Git.node, WorkArtifact.node],
})
