import { Effect } from "effect"
import { applyEdits, modify } from "jsonc-parser"
import { ConfigFile } from "../../src/config/file"
import { FSUtil } from "../../src/fs-util"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"

const file = process.argv[2]
const field = process.argv[3]
await Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  yield* ConfigFile.update(fs, file, (text) =>
    Effect.gen(function* () {
      yield* Effect.sleep("100 millis")
      return applyEdits(text ?? "{}", modify(text ?? "{}", [field], true, {}))
    }),
  )
}).pipe(Effect.provide(AppNodeBuilder.build(FSUtil.node)), Effect.runPromise)
console.log("writer718-exited:" + field)
