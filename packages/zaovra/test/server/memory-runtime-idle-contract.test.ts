import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BackgroundJob } from "@zaovra-ai/core/background-job"
import { MemoryAutomaticIdle } from "@zaovra-ai/core/memory/automatic-idle"
import { MemoryTidyTasks } from "@zaovra-ai/core/memory/tidy-tasks"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionSchema } from "@zaovra-ai/core/session/schema"
import { observeRuntime } from "../../script/evaluation/runtime-idle"

test("missing host services never imply idle", async () => {
  expect(await Effect.runPromise(observeRuntime)).toMatchObject({ idle: false, reason: "unavailable", active: null })
})

for (const mode of ["idle", "changed", "missing-status", "invalid-version", "tidy", "defect", "pending"] as const)
  test(`runtime observation conservatively handles ${mode}`, async () => {
    let reads = 0
    let idleReads = 0
    const host = Layer.mergeAll(
      Layer.mock(SessionExecution.Service, {
        ...(mode === "missing-status"
          ? {}
          : {
              status: Effect.sync(() => ({
                epoch: mode === "invalid-version" ? NaN : 1,
                revision: mode === "changed" ? reads++ : 0,
                active: new Set<SessionSchema.ID>(),
              })),
            }),
      }),
      Layer.mock(MemoryAutomaticIdle.Service, {
        available: (except) => {
          expect(except).toBeUndefined()
          idleReads++
          return mode === "defect" ? Effect.die("sensitive fixture error") : Effect.succeed(mode !== "pending")
        },
      }),
      Layer.mock(MemoryTidyTasks.Service, {
        active: Effect.succeed(new Set(mode === "tidy" ? ["private-tidy-id"] : [])),
      }),
      Layer.mock(BackgroundJob.Service, { list: () => Effect.succeed([]) }),
    )
    const result = await Effect.runPromise(observeRuntime.pipe(Effect.provide(host)))
    expect(result.idle).toBe(mode === "idle")
    expect(result.reason).toBe(
      mode === "idle"
        ? "idle-observed"
        : mode === "changed"
          ? "version-changed"
          : mode === "tidy" || mode === "pending"
            ? "busy"
            : "unavailable",
    )
    expect(JSON.stringify(result)).not.toContain("private-tidy-id")
    expect(JSON.stringify(result)).not.toContain("sensitive fixture error")
    if (mode === "idle") expect(idleReads).toBe(2)
  })
