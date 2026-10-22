import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { SessionRunCoordinator } from "@zaovra-ai/core/session/run-coordinator"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

it.effect("S1 Stop freezes wakes during cleanup and after ownership is removed until explicit resume", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const runs: boolean[] = []
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: (_key, force) =>
          Effect.sync(() => runs.push(force)).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                runs.length === 1
                  ? Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.ensuring(
                        Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(release))),
                      ),
                    )
                  : Effect.void,
              ),
            ),
          ),
      })
      yield* coordinator.wake("session")
      yield* Deferred.await(started)
      const stop = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
      yield* Deferred.await(cleaning)
      yield* coordinator.wake("session")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(stop)
      yield* coordinator.wait("session")
      yield* coordinator.wake("session")
      yield* Effect.yieldNow
      expect(runs).toEqual([false])
      expect((yield* coordinator.active).size).toBe(0)
      yield* coordinator.run("session")
      expect(runs).toEqual([false, true])
    }),
  ),
)

it.effect("S1 a queued completion whose wake arrives after idle Stop cannot start a drain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const runs: boolean[] = []
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: (_key, force) => Effect.sync(() => runs.push(force)),
      })
      yield* coordinator.interrupt("session")
      yield* coordinator.wake("session")
      yield* Effect.yieldNow
      expect(runs).toEqual([])
      yield* coordinator.run("session")
      expect(runs).toEqual([true])
    }),
  ),
)

describe("SessionRunCoordinator", () => {
  it.effect("completes observers when execution interrupts without interrupting the observer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(Effect.interrupt),
            ),
        })
        yield* coordinator.wake("session")
        yield* Deferred.await(started)
        const observer = yield* coordinator.wait("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(gate, undefined)
        expect(Exit.isSuccess(yield* Fiber.await(observer))).toBe(true)
        expect((yield* coordinator.active).size).toBe(0)
      }),
    ),
  )

  it.effect("cancelling an observer preserves execution and the observer interruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        })
        yield* coordinator.wake("session")
        yield* Deferred.await(started)
        const observer = yield* coordinator.wait("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(observer)
        const exit = yield* Fiber.await(observer)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect((yield* coordinator.active).has("session")).toBe(true)
        yield* Deferred.succeed(gate, undefined)
        yield* coordinator.wait("session")
      }),
    ),
  )
  it.effect("joins concurrent resumes for one key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate))),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const second = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow

        expect(runs).toBe(1)
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(second)])
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("joins a wake-started execution without forcing a successor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) =>
            Effect.sync(() => forces.push(force)).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(gate)),
            ),
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(started)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(resumed)

        expect(forces).toEqual([false])
      }),
    ),
  )

  it.effect("starts execution when woken while idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drained = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({ drain: () => Deferred.succeed(drained, undefined) })

        yield* coordinator.wake("session")
        yield* Deferred.await(drained)
      }),
    ),
  )

  it.effect("waits for active execution without starting idle work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(gate)),
            ),
        })

        yield* coordinator.wait("idle")
        expect(runs).toBe(0)
        yield* coordinator.wake("session")
        yield* Deferred.await(started)
        const waiting = yield* coordinator.wait("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(waiting)
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("serializes an exclusive operation and preserves a pending wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationStarted = yield* Deferred.make<void>()
        const operationGate = yield* Deferred.make<void>()
        const drained = yield* Deferred.make<void>()
        const order: string[] = []
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => order.push("drain")).pipe(Effect.andThen(Deferred.succeed(drained, undefined))),
        })
        const operation = Effect.sync(() => order.push("exclusive")).pipe(
          Effect.andThen(Deferred.succeed(operationStarted, undefined)),
          Effect.andThen(Deferred.await(operationGate)),
        )

        const running = yield* coordinator.exclusive("session", operation).pipe(Effect.forkChild)
        yield* Deferred.await(operationStarted)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(operationGate, undefined)
        yield* Fiber.join(running)
        yield* Deferred.await(drained)

        expect(order).toEqual(["exclusive", "drain"])
      }),
    ),
  )

  it.effect("snapshots only active executions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const secondGate = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (key: string) =>
            Deferred.succeed(key === "first" ? firstStarted : secondStarted, undefined).pipe(
              Effect.andThen(Deferred.await(key === "first" ? firstGate : secondGate)),
            ),
        })

        expect(Array.from(yield* coordinator.active)).toEqual([])
        const first = yield* coordinator.run("first").pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        expect(Array.from(yield* coordinator.active)).toEqual(["first"])

        const second = yield* coordinator.run("second").pipe(Effect.forkChild)
        yield* Deferred.await(secondStarted)
        expect(Array.from(yield* coordinator.active)).toEqual(["first", "second"])

        yield* Deferred.succeed(firstGate, undefined)
        yield* Fiber.join(first)
        expect(Array.from(yield* coordinator.active)).toEqual(["second"])
        yield* Deferred.succeed(secondGate, undefined)
        yield* Fiber.join(second)
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("cleans active executions after failure and defect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = new Error("failed")
        const defect = new Error("defect")
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (key: string) => (key === "failure" ? Effect.fail(failure) : Effect.die(defect)),
        })

        const failed = yield* coordinator.run("failure").pipe(Effect.exit)
        expect(Exit.isFailure(failed) && Cause.hasFails(failed.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])

        const died = yield* coordinator.run("defect").pipe(Effect.exit)
        expect(Exit.isFailure(died) && Cause.hasDies(died.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("cleans active executions when its scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const coordinator = yield* Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* SessionRunCoordinator.make({
            drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          })
          yield* coordinator.wake("session")
          yield* Deferred.await(started)
          expect(Array.from(yield* coordinator.active)).toEqual(["session"])
          return coordinator
        }),
      )

      expect(Array.from(yield* coordinator.active)).toEqual([])
    }),
  )

  it.effect("coalesces wakes received during active execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstGate)))
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        yield* Effect.all([coordinator.wake("session"), coordinator.wake("session"), coordinator.wake("session")], {
          concurrency: "unbounded",
        })
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)
        yield* Fiber.join(resumed)

        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("runs again when woken during the follow-up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const secondGate = yield* Deferred.make<void>()
        const thirdStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.await(firstGate)
                  : run === 2
                    ? Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(secondGate)))
                    : Deferred.succeed(thirdStarted, undefined),
              ),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* coordinator.wake("session")
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(secondGate, undefined)
        yield* Deferred.await(thirdStarted)
        yield* Fiber.join(resumed)

        expect(runs).toBe(3)
      }),
    ),
  )

  it.effect("does nothing when interrupted while idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* SessionRunCoordinator.make({ drain: () => Effect.void })
        yield* coordinator.interrupt("session")
      }),
    ),
  )

  it.effect("interrupts active execution and clears its pending wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* coordinator.wake("session")
        yield* coordinator.interrupt("session")
        yield* Deferred.await(interrupted)

        const exit = yield* Fiber.await(resumed)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("drops automatic wakes registered during interruption cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() =>
                        Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
                      ),
                    )
                  : Effect.void,
              ),
            ),
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(firstStarted)
        const interrupt = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Fiber.join(interrupt)
        yield* Effect.yieldNow
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("starts a resume registered during interruption cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) => {
            forces.push(force)
            return forces.length === 1
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
                  ),
                )
              : Deferred.succeed(secondStarted, undefined)
          },
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(firstStarted)
        const interrupt = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        // Drain the scheduler before releasing cleanup: resume must enter the stopping branch.
        yield* Effect.yieldNow
        expect(forces).toEqual([false])
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Effect.all([Fiber.join(interrupt), Fiber.join(resumed)])
        yield* Deferred.await(secondStarted)

        expect(forces).toEqual([false, true])
      }),
    ),
  )

  it.effect("starts one follow-up when a wake races with failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const failure = new Error("failed")
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.await(gate).pipe(Effect.andThen(Effect.fail(failure)))
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* coordinator.wake("session")
        yield* Deferred.succeed(gate, undefined)

        expect(yield* Fiber.join(resumed).pipe(Effect.flip)).toBe(failure)
        yield* Deferred.await(secondStarted)
        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("does not cancel execution when a joined waiter is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate))),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const second = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Fiber.interrupt(second)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)

        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("runs different keys concurrently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const bothStarted = yield* Deferred.make<void>()
        let active = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++active).pipe(
              Effect.tap(() => (active === 2 ? Deferred.succeed(bothStarted, undefined) : Effect.void)),
              Effect.andThen(Deferred.await(gate)),
            ),
        })

        const first = yield* coordinator.run("first").pipe(Effect.forkChild)
        const second = yield* coordinator.run("second").pipe(Effect.forkChild)
        yield* Deferred.await(bothStarted)
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      }),
    ),
  )

  it.effect("trampolines synchronous self-waking execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const limit = 20_000
        const completed = yield* Deferred.make<void>()
        let runs = 0
        let wake: (key: string) => Effect.Effect<void> = () => Effect.void
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (key) =>
            Effect.sync(() => ++runs).pipe(
              Effect.tap((run) => (run < limit ? wake(key) : Deferred.succeed(completed, undefined))),
              Effect.asVoid,
            ),
        })
        wake = coordinator.wake

        yield* coordinator.wake("session")
        yield* Deferred.await(completed)

        expect(runs).toBe(limit)
      }),
    ),
  )
})

for (const arrival of ["before", "during", "after"] as const) {
  it.effect(`S1 explicit input arriving ${arrival} Stop waits for all tail cleanup`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const ownerCleaning = yield* Deferred.make<void>()
        const ownerGate = yield* Deferred.make<void>()
        const tailCleaning = yield* Deferred.make<void>()
        const tailGate = yield* Deferred.make<void>()
        const successor = yield* Deferred.make<void>()
        const runs: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) =>
            Effect.sync(() => runs.push(force)).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  runs.length === 1
                    ? Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Effect.never),
                        Effect.ensuring(
                          Deferred.succeed(ownerCleaning, undefined).pipe(Effect.andThen(Deferred.await(ownerGate))),
                        ),
                      )
                    : Deferred.succeed(successor, undefined),
                ),
              ),
            ),
        })
        yield* coordinator.wake("session")
        yield* Deferred.await(started)
        const oldIntent = yield* coordinator.prepareWake("session")
        yield* coordinator.freezeWake("session")
        if (arrival === "before") {
          yield* Effect.forEach([0, 1, 2], () =>
            coordinator.prepareWake("session").pipe(Effect.flatMap((intent) => intent)),
          )
        }
        const stop = yield* coordinator
          .interrupt(
            "session",
            Deferred.succeed(tailCleaning, undefined).pipe(Effect.andThen(Deferred.await(tailGate))),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(ownerCleaning)
        // A pre-Stop admission that completes late belongs to the stopped generation.
        yield* oldIntent
        yield* coordinator.wake("session")
        yield* Deferred.succeed(ownerGate, undefined)
        yield* Deferred.await(tailCleaning)
        if (arrival === "during") {
          yield* Effect.forEach([0, 1, 2], () =>
            coordinator.prepareWake("session").pipe(Effect.flatMap((intent) => intent)),
          )
        }
        yield* Effect.yieldNow
        expect(runs).toEqual([false])
        expect((yield* coordinator.active).has("session")).toBe(true)
        yield* Deferred.succeed(tailGate, undefined)
        yield* Fiber.join(stop)
        if (arrival === "after") {
          const intent = yield* coordinator.prepareWake("session")
          yield* intent
        }
        yield* Deferred.await(successor)
        yield* coordinator.wait("session")
        expect(runs).toEqual([false, false])
      }),
    ),
  )
}

it.effect("S1 explicit resume during tail cleanup joins one successor after the barrier", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cleaning = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const successor = yield* Deferred.make<void>()
      const drainGate = yield* Deferred.make<void>()
      const runs: boolean[] = []
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: (_key, force) =>
          Effect.sync(() => runs.push(force)).pipe(
            Effect.andThen(Deferred.succeed(successor, undefined)),
            Effect.andThen(Deferred.await(drainGate)),
          ),
      })
      const stop = yield* coordinator
        .interrupt("session", Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(gate))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(cleaning)
      const resume = yield* coordinator.run("session").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* coordinator.wake("session")
      expect(runs).toEqual([])
      yield* Deferred.succeed(gate, undefined)
      yield* Deferred.await(successor)
      yield* Deferred.succeed(drainGate, undefined)
      yield* Effect.all([Fiber.join(stop), Fiber.join(resume)])
      expect(runs).toEqual([true])
    }),
  ),
)

it.effect("cancelling an execution owner stops its drain, while observers cannot stop it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
      })
      const owner = yield* coordinator.owned("session", { id: "worker:1", check: Effect.void }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const observer = yield* coordinator.run("session").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(observer)
      expect((yield* coordinator.active).has("session")).toBe(true)
      // A different claimant cannot adopt this execution or cancel it on failure.
      const stale = yield* coordinator.owned("session", { id: "worker:0", check: Effect.void }).pipe(Effect.exit)
      expect(Exit.isFailure(stale)).toBe(true)
      expect((yield* coordinator.active).has("session")).toBe(true)
      yield* coordinator.wake("session")
      yield* Fiber.interrupt(owner)
      yield* Deferred.await(stopped)
      expect((yield* coordinator.active).size).toBe(0)
    }),
  ),
)

it.effect("an invalid owner cannot start a drain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: string[] = []
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () =>
          Effect.sync(() => {
            calls.push("provider")
          }),
      })
      const result = yield* coordinator.owned("session", { id: "worker:0", check: Effect.interrupt }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(calls).toEqual([])
    }),
  ),
)
