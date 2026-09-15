export * as SystemContextBuiltIns from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { SystemContext } from "./index"
import { InstructionContext } from "../instruction-context"
import { SystemContextRegistry } from "./registry"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Config } from "../config"
import { AppProcess } from "../process"

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const config = yield* Config.Service
    const environment = [
      "<env>",
      `  Working directory: ${location.directory}`,
      `  Workspace root folder: ${location.project.directory}`,
      `  Is directory a git repo: ${location.vcs?.type === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      "</env>",
    ].join("\n")
    const context = SystemContext.combine([
      SystemContext.make({
        key: SystemContext.Key.make("core/environment"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.gen(function* () {
          const shell = AppProcess.resolveShell(Config.latest(yield* config.entries(), "shell"))
          return `${environment}\nExecution shell: ${shell}. Use this shell's syntax, not another shell's quoting or operators. For embedded multiline code, write a script file and invoke it. An exit code of 0 only reports process success, not task acceptance.`
        }),
        baseline: (environment) =>
          ["Here is some useful information about the environment you are running in:", environment].join("\n"),
        update: (_previous, environment) => ["The environment you are running in is now:", environment].join("\n"),
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/date"),
        codec: Schema.toCodecJson(Schema.String),
        load: DateTime.nowAsDate.pipe(Effect.map((date) => date.toDateString())),
        baseline: (date) => `Today's date: ${date}`,
        update: (_previous, date) => `Today's date is now: ${date}`,
      }),
    ])

    yield* registry.register({ key: SystemContext.Key.make("core/builtins"), load: Effect.succeed(context) })
  }),
)

export const node = makeLocationNode({
  name: "system-context-builtins",
  layer: builtIns,
  deps: [Location.node, SystemContextRegistry.node, InstructionContext.node, FSUtil.node, Global.node, Config.node],
})
