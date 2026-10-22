export * as SessionRunCoordinator from "./run-coordinator"

import { SessionOwnership } from "./ownership"
import { Cause, Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Starts an exclusive drain; cancellation stops only this concrete entry, never a replacement. */
  readonly owned: (key: Key, claim: SessionOwnership.Claim) => Effect.Effect<void, E>
  /** Waits for current execution without starting new work. */
  readonly wait: (key: Key) => Effect.Effect<void, E>
  /** Runs one serialized operation after current execution becomes idle. */
  readonly exclusive: (key: Key, operation: Effect.Effect<void, E>) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
  /** Freeze automatic wakes synchronously before publishing Stop. */
  readonly freezeWake: (key: Key) => Effect.Effect<void>
  /** Explicit input admission permits future advisory wakes again. */
  readonly allowWake: (key: Key) => Effect.Effect<void>
}

type Entry<E> = {
  readonly done: Deferred.Deferred<void, E>
  readonly observed: Deferred.Deferred<Exit.Exit<void, E>>
  owner?: Fiber.Fiber<void, never>
  claim?: SessionOwnership.Claim
  pendingWake: boolean
  stopping: boolean
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean, claim?: SessionOwnership.Claim) => Effect.Effect<void, E>
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    const stopped = new Set<Key>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      observed: Deferred.makeUnsafe<Exit.Exit<void, E>>(),
      pendingWake: false,
      stopping: false,
    })

    const start = (
      key: Key,
      entry: Entry<E>,
      force: boolean,
      successor = false,
      operation?: Effect.Effect<void, E>,
    ) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(operation ?? Effect.suspend(() => options.drain(key, force, entry.claim))),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) => {
      if (Exit.isSuccess(exit) && !entry.stopping && !stopped.has(key) && entry.pendingWake) {
        entry.pendingWake = false
        start(key, entry, false, true)
        return
      }

      const successor =
        entry.pendingWake && !entry.stopping && !stopped.has(key) && !entry.claim ? makeEntry() : undefined
      if (successor === undefined) active.delete(key)
      else {
        active.set(key, successor)
        start(key, successor, false, true)
      }
      Deferred.doneUnsafe(entry.done, exit)
      Deferred.doneUnsafe(entry.observed, Effect.succeed(exit))
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry()
        stopped.delete(key)
        active.set(key, next)
        start(key, next, true)
        return restore(Deferred.await(next.done))
      })

    const owned = (key: Key, claim: SessionOwnership.Claim): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* restore(claim.check)
          // Never adopt a different drain by Session ID, even if its owner label matches.
          if (active.has(key)) return yield* Effect.die("Session already has an active execution owner")
          const entry = makeEntry()
          stopped.delete(key)
          entry.claim = claim
          active.set(key, entry)
          start(key, entry, true)
          return yield* restore(Deferred.await(entry.done)).pipe(
            Effect.onInterrupt(() =>
              Effect.suspend(() => {
                if (active.get(key) !== entry || !entry.owner) return Effect.void
                entry.stopping = true
                entry.pendingWake = false
                return Fiber.interrupt(entry.owner)
              }),
            ),
          )
        }),
      )

    const wait = (key: Key): Effect.Effect<void, E> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        // Observers receive interruption as a completed result, while cancellation
        // of the observer itself still interrupts its own Deferred.await.
        return entry === undefined
          ? Effect.void
          : Deferred.await(entry.observed).pipe(
              Effect.flatMap((exit) =>
                Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Effect.void : exit,
              ),
            )
      })

    const exclusive = (key: Key, operation: Effect.Effect<void, E>): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined)
          return restore(Deferred.await(entry.done).pipe(Effect.andThen(exclusive(key, operation))))

        const next = makeEntry()
        active.set(key, next)
        start(key, next, false, false, operation)
        return restore(Deferred.await(next.done))
      })

    const wake = (key: Key) =>
      Effect.sync(() => {
        if (stopped.has(key)) return
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return
          entry.pendingWake = true
          return
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, false)
      })

    const freezeWake = (key: Key) =>
      Effect.sync(() => {
        stopped.add(key)
        const entry = active.get(key)
        if (!entry) return
        entry.stopping = true
        entry.pendingWake = false
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      freezeWake(key).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const entry = active.get(key)
            return entry?.owner ? Fiber.interrupt(entry.owner) : Effect.void
          }),
        ),
      )

    return {
      active: Effect.sync(() => new Set(active.keys())),
      run,
      owned,
      wait,
      exclusive,
      wake,
      interrupt,
      freezeWake,
      allowWake: (key) =>
        Effect.sync(() => {
          stopped.delete(key)
        }),
    }
  })
