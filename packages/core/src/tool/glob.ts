export * as GlobTool from "./glob"

import { ToolFailure } from "@zaovra-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { safetyFailure } from "./safety-failure"

export const name = "glob"

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Glob pattern to match files against" }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description:
      "Directory to search. Relative paths stay in the active Location; external absolute directories require external_directory approval.",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: "Maximum results to return (default 100). Narrow the search if incomplete.",
  }),
})

export const Output = Schema.Struct({
  entries: Schema.Array(FileSystem.Entry),
  truncated: Schema.Boolean,
  partial: Schema.Boolean,
  skippedRecords: Schema.Number,
})
type ModelOutput = typeof Output.Encoded

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelOutput = (output: ModelOutput) => {
  const lines =
    output.entries.length === 0 && !output.partial ? ["No files found"] : output.entries.map((item) => item.path)
  if (output.truncated) lines.push("Result limit reached; narrow the path/pattern or set an explicit limit.")
  if (output.partial)
    lines.push(`Partial search: ${output.skippedRecords} overlong records skipped; some files may be missing.`)
  return lines.join("\n")
}

/** Glob leaf that defaults its filesystem root to the active Location. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service

    yield* tools
      .register({
        [name]: Tool.make({
          observation: true,
          description:
            "Find files by glob pattern within the active Location or a separately approved external absolute directory. Returns concise relative file resources. Use a path to narrow the search and limit to bound the result count.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutput({
                ...output,
                entries: output.entries.map((entry) => ({
                  ...entry,
                  path: path.resolve(location.directory, entry.path),
                })),
              }),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.path ?? ".", kind: "directory" })
              if (target.externalDirectory)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: input.path ?? ".",
                  path: input.path,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const current = yield* mutation.resolve({ path: input.path ?? ".", kind: "directory" })
              if (
                current.canonical !== target.canonical ||
                current.resource !== target.resource ||
                (current.identity &&
                  target.identity &&
                  LocationMutation.identityKey(current.identity) !== LocationMutation.identityKey(target.identity))
              )
                return yield* new ToolFailure({
                  message:
                    "Search target changed during permission approval. Resolve the path and request permission again.",
                })
              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* new ToolFailure({ message: "Search target must be a directory." })
              const cwd = target.canonical
              return yield* ripgrep
                .globSummary({
                  cwd,
                  pattern: input.pattern,
                  limit: input.limit ?? 100,
                })
                .pipe(
                  Effect.map((result) => ({
                    truncated: result.truncated,
                    partial: result.partial,
                    skippedRecords: result.skippedRecords,
                    entries: result.items.map((entry) =>
                      FileSystem.Entry.make({
                        ...entry,
                        path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                      }),
                    ),
                  })),
                )
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : (safetyFailure(error) ??
                    new ToolFailure({ message: `Unable to find files matching ${input.pattern}` })),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/glob",
  layer,
  deps: [ToolRegistry.node, Ripgrep.node, Location.node, PermissionV2.node, LocationMutation.node, FSUtil.node],
})
