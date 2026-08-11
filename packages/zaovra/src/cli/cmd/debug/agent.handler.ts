import { EOL } from "os"
import { basename } from "path"
import { Effect } from "effect"
import { Agent } from "../../../agent/agent"
import { fail } from "../../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"

export const debugAgent = Effect.fn("Cli.debug.agent")(function* (args: {
  name: string
  tool?: string
  params?: string
}) {
  const ctx = yield* InstanceRef
  if (!ctx) return
  return yield* run(args, ctx)
})

const run = Effect.fn("Cli.debug.agent.body")(function* (
  args: { name: string; tool?: string; params?: string },
  _ctx: InstanceContext,
) {
  const agent = yield* Agent.Service.use((svc) => svc.get(args.name))
  if (!agent) {
    process.stderr.write(
      `Agent ${args.name} not found, run '${basename(process.execPath)} agent list' to get an agent list` + EOL,
    )
    return yield* fail("", 1)
  }
  if (args.tool) return yield* fail("Legacy tool execution is not available; use a V2 session to execute tools.")
  process.stdout.write(JSON.stringify(agent, null, 2) + EOL)
})
