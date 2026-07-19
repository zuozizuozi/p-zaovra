import { run as runTui, type TuiInput } from "@zaovra-ai/tui"
import { Global } from "@zaovra-ai/core/global"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
