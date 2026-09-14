export * as EvidenceTool from "./evidence"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@zaovra-ai/llm"
import { Evidence } from "../evidence"
import { PermissionV2 } from "../permission"
import { makeLocationNode } from "../effect/app-node"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { ToolRegistry } from "./registry"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const evidence = yield* Evidence.Service
    const permission = yield* PermissionV2.Service
    for (const name of ["evidence_read", "evidence_search"] as const) {
      yield* tools
        .register({
          [name]: Tool.make({
            description:
              "Retrieve retained original tool output by Evidence ID, without rerunning the command. Offsets and lengths are UTF-8 bytes. Search is literal and paginated; no matches in one page does not mean no matches in the full log. snapshotBytes is the observed file size, not proof the producer has finished. IDs are session-owned and expire with retained output. Use nextOffset for continuation.",
            input: Schema.Struct({
              id: Schema.String,
              offset: Schema.optional(Schema.Number),
              length: Schema.optional(Schema.Number),
              query: Schema.optional(Schema.String),
            }),
            output: Schema.Struct({
              producer: Schema.Literals(["complete", "writing", "outcome_unknown"]),
              id: Schema.String,
              offset: Schema.Number,
              nextOffset: Schema.optional(Schema.Number),
              snapshotBytes: Schema.Number,
              text: Schema.String,
              matches: Schema.optional(Schema.Array(Schema.Struct({ offset: Schema.Number, text: Schema.String }))),
            }),
            execute: (input, context) =>
              Effect.gen(function* () {
                yield* permission.assert({
                  action: "read",
                  resources: [`evidence:${input.id}`],
                  save: [],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                if (name === "evidence_search" && !input.query)
                  return yield* new ToolFailure({ message: "A literal search query is required" })
                return yield* evidence
                  .read(
                    context.sessionID,
                    input.id,
                    input.offset ?? 0,
                    input.length ?? 16384,
                    name === "evidence_search" ? input.query : undefined,
                  )
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : new ToolFailure({ message: error.message }),
                ),
              ),
          }),
        })
        .pipe(Effect.orDie)
    }
  }),
)
export const node = makeLocationNode({
  name: "tool/evidence",
  layer,
  deps: [ToolRegistry.node, Evidence.node, PermissionV2.node],
})
