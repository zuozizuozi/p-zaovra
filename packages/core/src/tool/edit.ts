/**
 * Model-facing V2 exact-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as EditTool from "./edit"

import { ToolFailure } from "@zaovra-ai/llm"
import { FileDiff } from "@zaovra-ai/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FileBackup } from "../file-backup"
import { Formatter } from "../formatter"
import { LSP } from "../lsp"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { safetyFailure } from "./safety-failure"

export const name = "edit"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
  }),
  oldString: Schema.String.annotate({ description: "Exact text to replace" }),
  newString: Schema.String.annotate({ description: "Replacement text, which must differ from oldString" }),
  replaceAll: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Replace all exact occurrences of oldString (default false)",
  }),
})

export const Output = Schema.Struct({
  backup: FileBackup.Status.pipe(Schema.optional),
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
  formatting: Formatter.Result.pipe(Schema.optional),
  lsp: LSP.Report.pipe(Schema.optional),
  target: Schema.String.pipe(Schema.optional),
})
export type Output = typeof Output.Type

const normalizeLineEndings = (text: string) => text.replaceAll("\r\n", "\n")
const convertToLineEnding = (text: string, ending: "\n" | "\r\n") =>
  ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")

function regionLineEnding(content: string, offset: number, length: number) {
  const region = content.slice(offset, offset + length)
  const crlf = region.match(/\r\n/g)?.length ?? 0
  const lf = region.match(/(?<!\r)\n/g)?.length ?? 0
  if (crlf > lf) return "\r\n"
  if (lf > crlf) return "\n"
  if (crlf + lf > 0)
    return region.includes("\r\n") && region.indexOf("\r\n") === region.indexOf("\n") - 1 ? "\r\n" : "\n"
  const next = content.indexOf("\n", offset + length)
  if (next !== -1) return content[next - 1] === "\r" ? "\r\n" : "\n"
  const previous = content.lastIndexOf("\n", offset)
  return previous > 0 && content[previous - 1] === "\r" ? "\r\n" : "\n"
}

const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const joinBom = (text: string, bom: boolean) => (bom ? `\uFEFF${text}` : text)
const decodeUtf8 = (content: Uint8Array) => {
  const bom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
  return {
    bom,
    content,
    text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? content.slice(3) : content),
  }
}

const countOccurrences = (content: string, search: string) => {
  if (search === "") return content.length + 1
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count++
    offset += search.length
  }
  return count
}

const previewLines = (value: string, prefix: "+" | "-") => {
  const lines = normalizeLineEndings(value).split("\n")
  const shown = lines.slice(0, 6).map((line) => `${prefix}${line.length > 240 ? `${line.slice(0, 240)}...` : line}`)
  if (lines.length > shown.length) shown.push(`${prefix}...`)
  return shown
}

function candidateLines(content: string, search: string) {
  const anchor = search
    .split("\n", 32)
    .find((line) => line.trim())
    ?.trim()
    .replace(/\s+/gu, " ")
  if (!anchor || anchor.length > 256) return ""
  const candidates = content
    .slice(0, 256 * 1024)
    .split("\n", 10_000)
    .flatMap((line, index) =>
      line.slice(0, 1024).trim().replace(/\s+/gu, " ") === anchor ? [`Line ${index + 1}: ${line.slice(0, 160)}`] : [],
    )
    .slice(0, 5)
  return candidates.length === 0
    ? ""
    : `\nCandidate lines (bounded hints only; no fuzzy replacement was performed). Read the file and retry with exact text:\n${candidates.join("\n")}`
}

export const toModelOutput = (output: Output, oldString: string, newString: string) =>
  [
    `Edited file successfully: ${output.files[0]?.file}`,
    `Replacements: ${output.replacements}`,
    "```diff",
    ...(output.formatting
      ? (output.files[0]?.patch ?? "").split("\n").slice(0, 20)
      : [...previewLines(oldString, "-"), ...previewLines(newString, "+")]),
    "```",
    ...(output.formatting?.failed.length
      ? [
          `Automatic formatting failed: ${output.formatting.failed.join(", ")}. Read the file before making further edits.`,
        ]
      : []),
    LSP.describe(output.lsp),
    FileBackup.describe(output.backup),
  ]
    .filter(Boolean)
    .join("\n")

/** Deferred V2 edit behavior and UX integrations remain visible at the model-facing seam. */
// TODO: Port V1 fuzzy correction strategies only after exact-edit behavior is established: line-trimmed matching, block-anchor fallback, indentation correction, and similarity-threshold review.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Replace exact text in one UTF-8 file. Invalid UTF-8 is rejected without writing; do not automatically transcode it. Preserve untouched bytes and use the matched region's line endings for replacement text, including mixed-ending files. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.",
            input: Input,
            output: Output,
            toModelOutput: ({ input, output }) => [
              { type: "text", text: toModelOutput(output, input.oldString, input.newString) },
            ],
            execute: (input, context) => {
              const unableToEdit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.mapError(
                    (error) => safetyFailure(error) ?? new ToolFailure({ message: `Unable to edit ${input.path}` }),
                  ),
                )

              return Effect.gen(function* () {
                const permissionSource = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (input.oldString === input.newString) {
                  return yield* new ToolFailure({
                    message: "No changes to apply: oldString and newString are identical.",
                  })
                }
                if (input.oldString === "") {
                  return yield* new ToolFailure({
                    message: "oldString must not be empty. Use write to create or overwrite a file.",
                  })
                }

                const target = yield* unableToEdit(mutation.resolve({ path: input.path, kind: "file" }))
                const external = target.externalDirectory
                if (external) {
                  yield* unableToEdit(
                    permission.assert({
                      ...LocationMutation.externalDirectoryPermission(external),
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: permissionSource,
                    }),
                  )
                }

                yield* unableToEdit(
                  permission.assert({
                    action: "edit",
                    resources: [target.resource],
                    save: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: permissionSource,
                  }),
                )
                const content = yield* unableToEdit(fs.readFile(target.canonical))
                const source = yield* Effect.try({
                  try: () => decodeUtf8(content),
                  catch: () =>
                    new ToolFailure({
                      message: `File is not valid UTF-8: ${input.path}. Nothing was written. Do not automatically transcode or rewrite this file.`,
                    }),
                })
                const mixed = source.text.includes("\r\n") && source.text.replaceAll("\r\n", "").includes("\n")
                const oldString =
                  [
                    input.oldString,
                    convertToLineEnding(input.oldString, "\r\n"),
                    normalizeLineEndings(input.oldString),
                  ].find((value) => source.text.includes(value)) ?? input.oldString
                const replacements = countOccurrences(source.text, oldString)
                if (replacements === 0) {
                  return yield* new ToolFailure({
                    message:
                      "Could not find oldString in the file. It must match exactly, including whitespace and indentation." +
                      candidateLines(source.text, oldString),
                    metadata: { phase: "mutation", reason: "match-failed" },
                  })
                }
                if (replacements > 1 && input.replaceAll !== true) {
                  return yield* new ToolFailure({
                    message:
                      "Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true.",
                    metadata: { phase: "mutation", reason: "match-failed" },
                  })
                }

                const replacement = (_match: string, offset: number) =>
                  convertToLineEnding(input.newString, regionLineEnding(source.text, offset, oldString.length))
                const replaced =
                  input.replaceAll === true
                    ? source.text.replaceAll(oldString, replacement)
                    : source.text.replace(oldString, replacement)
                const result = yield* unableToEdit(
                  files.writeIfUnchanged({
                    sessionID: context.sessionID,
                    target,
                    expected: source.content,
                    content: joinBom(replaced, source.bom),
                    // A whole-file formatter could normalize unrelated mixed-ending lines.
                    format: !mixed,
                  }),
                )
                const diagnostics = yield* lsp.changed(result.target)
                return {
                  ...(result.backup?.reversible === false ? { backup: result.backup } : {}),
                  ...(Object.keys(diagnostics.diagnostics).length || diagnostics.failed.length
                    ? { lsp: diagnostics, target: result.target }
                    : {}),
                  files: [
                    {
                      file: result.resource,
                      patch: createTwoFilesPatch(
                        result.resource,
                        result.resource,
                        source.text,
                        splitBom(result.content ?? replaced).text,
                      ),
                      status: "modified" as const,
                      ...diffLines(source.text, splitBom(result.content ?? replaced).text).reduce(
                        (counts, item) => ({
                          additions: counts.additions + (item.added ? (item.count ?? 0) : 0),
                          deletions: counts.deletions + (item.removed ? (item.count ?? 0) : 0),
                        }),
                        { additions: 0, deletions: 0 },
                      ),
                    },
                  ],
                  replacements,
                  ...(result.formatting ? { formatting: result.formatting } : {}),
                } satisfies Output
              })
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/edit",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, LSP.node, FSUtil.node, PermissionV2.node],
})
