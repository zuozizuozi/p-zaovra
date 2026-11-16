export * as MemoryFileInvalidation from "./file-invalidation"

import { Memory } from "@zaovra-ai/schema/memory"
import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { WatcherSignal } from "../filesystem/watcher-signal"
import { Location } from "../location"
import { MemoryStore } from "./store"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const store = yield* MemoryStore.Service
    const signals = yield* WatcherSignal.Service
    const scope = yield* store.scope({ project: location.project.id, directory: location.directory })
    const invalidate = (files?: ReadonlyArray<string>) =>
      Effect.forEach([scope, Memory.Scope.user], (scope) =>
        store.invalidateFiles({ scope, directory: location.directory, paths: files }),
      ).pipe(Effect.asVoid)
    yield* signals.listen(invalidate)
    // Covers hints emitted before subscription. Store projections also reject later cross-process current writes.
    yield* invalidate()
    yield* Effect.addFinalizer(() => invalidate())
  }),
)

export const node = makeLocationNode({
  name: "memory-file-invalidation",
  layer,
  deps: [Location.node, MemoryStore.node, WatcherSignal.node],
})
