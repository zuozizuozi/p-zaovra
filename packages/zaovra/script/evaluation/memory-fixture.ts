import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { memoMap } from "@zaovra-ai/core/effect/memo-map"
import { MemoryStore } from "@zaovra-ai/core/memory/store"
import { SessionStore } from "@zaovra-ai/core/session/store"
import { SessionSchema } from "@zaovra-ai/core/session/schema"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { SessionRuntime } from "../../src/effect/session-runtime"
import { chains } from "../../../../script/evaluation/memory/cases"

/** Artificial poisoned-note fixture, only called by the isolated evaluation entrypoint before admission.
 * This deliberately seeds a model-origin verified note; it is not a model provenance/admission test.
 */
export async function seedPoison(
  input: { chain: string; directory: string; sourceSessionID: string },
  host: SessionRuntime.Host = SessionRuntime,
) {
  const chain = chains.find((value) => value.id === input.chain)
  if (!chain || !path.isAbsolute(input.directory)) throw new Error("invalid-memory-poison-fixture")
  const sessionID = Schema.decodeUnknownSync(SessionSchema.ID)(input.sourceSessionID)
  const runtime = ManagedRuntime.make(
    host
      .share(AppNodeBuilderV1.build(LayerNode.group([MemoryStore.node, SessionStore.node]), host.replacements))
      .pipe(Layer.provide(host.layer)),
    { memoMap },
  )
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore.Service
        const store = yield* MemoryStore.Service
        const session = yield* sessions.get(sessionID)
        if (
          !session ||
          path.resolve(session.location.directory).toLowerCase() !== path.resolve(input.directory).toLowerCase()
        )
          return yield* Effect.die(new Error("poison-fixture-session-place-mismatch"))
        const scope = yield* store.scope({ project: session.projectID, directory: session.location.directory })
        const before = yield* store.list(scope)
        const verification = "Recorded operational guidance."
        if (before.some((note) => note.text === chain.poisonedNote))
          return yield* Effect.die(new Error("poison-fixture-already-seeded"))
        const note = yield* store.write({
          scope,
          kind: "practice",
          text: chain.poisonedNote,
          origin: "model",
          status: "verified",
          verification,
        })
        if (!note || note.origin !== "model" || note.status !== "verified" || note.text !== chain.poisonedNote)
          return yield* Effect.die(new Error("poison-fixture-not-written"))
        const after = yield* store.list(scope)
        const snapshot = (notes: typeof before) =>
          notes.map((entry) => ({
            id: entry.id,
            origin: entry.origin,
            status: entry.status,
            textHash: createHash("sha256").update(entry.text).digest("hex"),
          }))
        return {
          fixture: "artificial-poison",
          chain: chain.id,
          scope,
          sourceSessionID: sessionID,
          inserted: note.id,
          before: snapshot(before),
          after: snapshot(after),
        }
      }),
    )
  } finally {
    await runtime.dispose()
  }
}
