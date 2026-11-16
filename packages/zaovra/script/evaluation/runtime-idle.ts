import { Effect, Layer, Option } from "effect"
import { BackgroundJob } from "@zaovra-ai/core/background-job"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { MemoryAutomaticIdle } from "@zaovra-ai/core/memory/automatic-idle"
import { MemoryTidyTasks } from "@zaovra-ai/core/memory/tidy-tasks"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { SessionRuntime } from "../../src/effect/session-runtime"

/** In-process evaluation host only. Keep this layer scoped alongside the actual Server.
 * Never substitute AppRuntime's legacy, InstanceState-wrapped BackgroundJob registry.
 */
export const layer = SessionRuntime.share(
  AppNodeBuilderV1.build(
    LayerNode.group([MemoryAutomaticIdle.node, MemoryTidyTasks.node, BackgroundJob.node]),
    SessionRuntime.replacements,
  ),
).pipe(Layer.provideMerge(SessionRuntime.layer))

export type Observation = {
  idle: boolean
  reason: "idle-observed" | "busy" | "version-changed" | "unavailable"
  epoch: number | null
  revision: number | null
  active: { execution: number; tidy: number; background: number } | null
}

const unavailable: Observation = { idle: false, reason: "unavailable", epoch: null, revision: null, active: null }

/** Two online observations, not a lock, durable quiescence seal or permission to kill the backend.
 * The host must separately validate its owned Job membership and stop it to empty afterward.
 * Failures are deliberately reduced to a whitelist; never expose exception text or job metadata.
 */
export const observeRuntime = Effect.gen(function* () {
  const execution = Option.getOrUndefined(yield* Effect.serviceOption(SessionExecution.Service))
  const idle = Option.getOrUndefined(yield* Effect.serviceOption(MemoryAutomaticIdle.Service))
  const tidy = Option.getOrUndefined(yield* Effect.serviceOption(MemoryTidyTasks.Service))
  const jobs = Option.getOrUndefined(yield* Effect.serviceOption(BackgroundJob.Service))
  if (!execution?.status || !idle || !tidy || !jobs) return unavailable
  const before = yield* execution.status
  const firstTidy = yield* tidy.active
  const firstJobs = yield* jobs.list()
  const firstIdle = yield* idle.available()
  const lastIdle = yield* idle.available()
  const lastTidy = yield* tidy.active
  const lastJobs = yield* jobs.list()
  const after = yield* execution.status
  if (
    ![before, after].every(
      (status) =>
        Number.isFinite(status.epoch) &&
        Number.isSafeInteger(status.revision) &&
        status.revision >= 0 &&
        status.active instanceof Set,
    )
  )
    return unavailable
  if (before.epoch !== after.epoch || before.revision !== after.revision)
    return { ...unavailable, reason: "version-changed" as const }
  const active = {
    execution: Math.max(before.active.size, after.active.size),
    tidy: Math.max(firstTidy.size, lastTidy.size),
    background: Math.max(
      firstJobs.filter((job) => job.status === "running").length,
      lastJobs.filter((job) => job.status === "running").length,
    ),
  }
  const available = firstIdle === true && lastIdle === true && Object.values(active).every((count) => count === 0)
  return {
    idle: available,
    reason: available ? ("idle-observed" as const) : ("busy" as const),
    epoch: after.epoch,
    revision: after.revision,
    active,
  }
}).pipe(
  Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(unavailable) }),
  Effect.catchCause(() => Effect.succeed(unavailable)),
)
