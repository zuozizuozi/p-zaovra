// Manual boundary probe: expected red until arbitrary, non-cooperating editors
// can be excluded or an actual filesystem compare-and-swap is available.
import path from "path"
import { Effect } from "effect"
import { ConfigFile } from "../../src/config/file"
import { FSUtil } from "../../src/fs-util"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"

const file = process.argv[2]
await Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  const before = '{"username":"before"}'
  const external = '// external edit after version check\n{"username":"external","disabled_providers":["openai"]}'
  yield* fs.writeFileString(file, before)
  const boundary = FSUtil.Service.of({
    ...fs,
    writeFileString: (target, text, options) =>
      Effect.gen(function* () {
        if (target === file) yield* fs.writeFileString(file, external)
        yield* fs.writeFileString(target, text, options)
      }),
  })
  const result = yield* ConfigFile.update(boundary, file, () => Effect.succeed('{"username":"application"}'))
  const retained = (yield* fs.readFileString(file)) === external
  console.log(
    JSON.stringify({
      scope: "editor ignores companion lock and writes after final comparison",
      externalRetained: retained,
      applicationAcknowledged: result.changed,
      unresolved: !retained,
    }),
  )
  if (!retained) process.exitCode = 1
}).pipe(Effect.provide(AppNodeBuilder.build(FSUtil.node)), Effect.runPromise)
