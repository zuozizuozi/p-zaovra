export * as WorkIsolation from "./isolation"

import { Work } from "@zaovra-ai/schema/work"
import { randomUUID } from "crypto"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Git } from "../git"
import { WorkArtifact } from "./artifact"

export interface Interface {
  readonly mergeBlocker: (goal: Work.GoalInfo, task: Work.TaskInfo) => Effect.Effect<string | undefined>
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
        yield* git.worktree.snapshot({
          repository,
          ref: `refs/zaovra/snapshots/${goal.id}/${task.id}/${randomUUID()}`,
          remove: true,
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

    const mergeBlocker = Effect.fn("WorkIsolation.mergeBlocker")(function* (goal: Work.GoalInfo, task: Work.TaskInfo) {
      if (!task.location || task.location.directory === goal.location.directory) return undefined
      return yield* Effect.gen(function* () {
        const repository = yield* git.repo.discover(task.location!.directory)
        const destination = yield* git.repo.discover(goal.location.directory)
        if (!repository || !destination || repository.commonDirectory !== destination.commonDirectory)
          return "Cannot verify isolated commit history; workspace retained for manual handling"
        const head = yield* git.history.head(destination)
        if (!head) return "Goal HEAD is unavailable; workspace retained for manual handling"
        const count = yield* git.history.ahead(repository, head)
        if (count === 0) return undefined
        const snapshot = yield* git.worktree.snapshot({
          repository,
          ref: `refs/zaovra/snapshots/${goal.id}/${task.id}/${randomUUID()}`,
        })
        return `任务在隔离目录中自行提交了 ${count} 个提交；已保存快照 ${snapshot.ref}；需人工合并。目录已保留，未自动合并。`
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("WorkGraph merge safety check failed", cause).pipe(
            Effect.as("Commit history or snapshot could not be verified; workspace retained for manual handling"),
          ),
        ),
      )
    })

    return Service.of({ archive, release, mergeBlocker })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Git.node, WorkArtifact.node],
})
