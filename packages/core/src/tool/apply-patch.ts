export * as ApplyPatchTool from "./apply-patch"

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
import { Patch } from "../patch"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { safetyFailure } from "./safety-failure"

export const name = "apply_patch"

const format = [
  "Use this custom patch format, not a unified diff. Send the patch itself as patchText, without Markdown fences.",
  "Start with *** Begin Patch and finish with *** End Patch. Between them use *** Add File: path, *** Update File: path, or *** Delete File: path.",
  "For Add, prefix each content line with +. Delete has no content lines.",
  "For Update, start each chunk with @@ on its own line, or @@ followed by literal existing context text (not unified-diff line numbers). Prefix each content line with + to insert, - to remove, or one space to keep unchanged context. Prefix blank lines too. Use the current file's text for removed/context lines.",
].join("\n")

const example =
  "*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Update File: existing.txt\n@@\n keep\n-before\n+after\n*** Delete File: obsolete.txt\n*** End Patch"

export const Input = Schema.Struct({
  patchText: Schema.String.annotate({
    description:
      "Custom patch text: *** Begin Patch, Add/Update/Delete File sections, then *** End Patch. Update chunks start with @@; content lines start with +, -, or a space. Add content lines start with +. See the tool description for a complete example.",
  }),
})

export const Applied = Schema.Struct({
  backup: FileBackup.Status.pipe(Schema.optional),
  type: Schema.Literals(["add", "update", "delete"]),
  resource: Schema.String,
  target: Schema.String,
  formatting: Formatter.Result.pipe(Schema.optional),
  lsp: LSP.Report.pipe(Schema.optional),
})

export const Output = Schema.Struct({
  applied: Schema.Array(Applied),
  files: Schema.Array(FileDiff.Info),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  [
    "Applied patch sequentially:",
    ...output.applied.map(
      (item) => `${item.type === "add" ? "A" : item.type === "delete" ? "D" : "M"} ${item.resource}`,
    ),
    ...output.applied.flatMap((item) =>
      item.formatting?.failed.length
        ? [
            `Automatic formatting failed for ${item.resource}: ${item.formatting.failed.join(", ")}. Read the file before making further edits.`,
          ]
        : [],
    ),
    ...output.applied.map((item) => LSP.describe(item.lsp)),
    ...output.applied
      .filter((item) => item.backup?.reversible === false)
      .map((item) => `${item.resource}: ${FileBackup.describe(item.backup)}`),
  ]
    .filter(Boolean)
    .join("\n")

type Prepared =
  | (Extract<Patch.Hunk, { readonly type: "add" | "delete" }> & {
      readonly target: LocationMutation.Target
      readonly before: string
      readonly after: string
    })
  | (Extract<Patch.Hunk, { readonly type: "update" }> & {
      readonly target: LocationMutation.Target
      readonly source: Uint8Array
      readonly mixed: boolean
      readonly content: string
      readonly before: string
      readonly after: string
    })

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
              "Apply one patch containing add, update, and delete file operations. All targets are resolved and approved before target contents are read. All updates must pass strict UTF-8 preflight before any file is written; do not automatically transcode invalid input. Preserve untouched lines byte-for-byte, including mixed LF/CRLF, and inherit local line endings for changed lines. Operations apply sequentially; if a later operation fails, earlier operations remain applied and the failure reports them explicitly. Moves and atomic rollback are not supported yet." +
              `\n\n${format}\n\nExample (existing.txt contains keep then before; obsolete.txt exists):\n\`\`\`patch\n${example}\n\`\`\``,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) => {
              const applied: Array<typeof Applied.Type> = []
              const fail = (path: string, error?: unknown) => {
                const prefix =
                  applied.length === 0
                    ? `Unable to apply patch at ${path}`
                    : `Patch partially applied before failing at ${path}. Applied: ${applied.map((item) => item.resource).join(", ")}`
                const safe = safetyFailure(error)
                if (!applied.length && safe) return safe
                return new ToolFailure({
                  message: prefix,
                  metadata: {
                    phase: "mutation",
                    reason: applied.length ? "partial-application" : "patch-failed",
                    ...(applied.length ? { appliedFiles: JSON.stringify(applied.map((item) => item.resource)) } : {}),
                  },
                })
              }
              return Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (!input.patchText.trim())
                  return yield* new ToolFailure({
                    message: `patchText is required. No patch operations were applied.\n${format}`,
                  })
                const hunks = yield* Effect.try({
                  try: () => Patch.parse(input.patchText),
                  catch: (cause) =>
                    new ToolFailure({
                      message: `apply_patch verification failed: ${String(cause)}\nNo patch operations were applied.\n${format}`,
                    }),
                })
                if (hunks.length === 0)
                  return yield* new ToolFailure({
                    message: `patch rejected: empty patch. No patch operations were applied.\n${format}`,
                  })
                const move = hunks.find((hunk) => hunk.type === "update" && hunk.movePath !== undefined)
                if (move) return yield* new ToolFailure({ message: "apply_patch moves are not supported yet" })

                const targets: Array<{ readonly hunk: Patch.Hunk; readonly target: LocationMutation.Target }> = []
                for (const hunk of hunks)
                  targets.push({ hunk, target: yield* mutation.resolve({ path: hunk.path, kind: "file" }) })
                const externalDirectories = new Map<string, LocationMutation.ExternalDirectoryAuthorization>()
                for (const { target } of targets) {
                  const external = target.externalDirectory
                  if (external) externalDirectories.set(external.resource, external)
                }
                for (const external of externalDirectories.values()) {
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                }
                yield* permission.assert({
                  action: "edit",
                  resources: [...new Set(targets.map(({ target }) => target.resource))],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })

                const prepared: Prepared[] = []
                for (const { hunk, target } of targets) {
                  yield* Effect.gen(function* () {
                    if (hunk.type === "add") {
                      prepared.push({
                        ...hunk,
                        target,
                        before: "",
                        after:
                          hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n`,
                      })
                      return
                    }
                    if ((yield* fs.stat(target.canonical)).type !== "File") yield* fail(hunk.path)
                    const source = yield* fs.readFile(target.canonical)
                    if (hunk.type === "delete") {
                      prepared.push({
                        ...hunk,
                        target,
                        before: new TextDecoder("utf-8", { ignoreBOM: true }).decode(source).replace(/^\uFEFF/, ""),
                        after: "",
                      })
                      return
                    }
                    const original = yield* Effect.try({
                      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source),
                      catch: () =>
                        new ToolFailure({
                          message: `File is not valid UTF-8: ${hunk.path}. No patch operations were applied. Do not automatically transcode or rewrite this file.`,
                        }),
                    })
                    const update = yield* Effect.try({
                      try: () => Patch.derive(hunk.path, hunk.chunks, original, true),
                      catch: () =>
                        new ToolFailure({
                          message: `Patch did not match ${hunk.path}. Read the file before retrying.`,
                          metadata: { phase: "mutation", reason: "match-failed" },
                        }),
                    })
                    const content = update.content
                    prepared.push({
                      ...hunk,
                      target,
                      source,
                      content: (update.bom ? "\uFEFF" : "") + content,
                      mixed: original.includes("\r\n") && original.replaceAll("\r\n", "").includes("\n"),
                      before: original.replace(/^\uFEFF/, ""),
                      after: content,
                    })
                  }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : fail(hunk.path, error))))
                }

                const patchFiles: FileDiff.Info[] = []
                yield* Effect.forEach(
                  prepared,
                  (change) =>
                    Effect.gen(function* () {
                      if (change.type === "add") {
                        const result = yield* files.create({
                          sessionID: context.sessionID,
                          target: change.target,
                          format: true,
                          content:
                            change.contents.endsWith("\n") || change.contents === ""
                              ? change.contents
                              : `${change.contents}\n`,
                        })
                        const diagnostics = yield* lsp.changed(result.target, context.sessionID)
                        applied.push({
                          ...(result.backup?.reversible === false ? { backup: result.backup } : {}),
                          ...(Object.keys(diagnostics.diagnostics).length || diagnostics.failed.length || diagnostics.pending?.length
                            ? { lsp: diagnostics }
                            : {}),
                          type: change.type,
                          resource: result.resource,
                          target: result.target,
                          ...(result.formatting ? { formatting: result.formatting } : {}),
                        })
                        patchFiles.push(patchFile({ ...change, after: result.content ?? change.after }))
                        return
                      }
                      if (change.type === "delete") {
                        const result = yield* files.remove({ target: change.target, sessionID: context.sessionID })
                        const diagnostics = yield* lsp.removed(result.target)
                        applied.push({
                          ...(result.backup?.reversible === false ? { backup: result.backup } : {}),
                          type: change.type,
                          resource: result.resource,
                          target: result.target,
                          ...(Object.keys(diagnostics.diagnostics).length || diagnostics.failed.length || diagnostics.pending?.length
                            ? { lsp: diagnostics }
                            : {}),
                        })
                        patchFiles.push(patchFile(change))
                        return
                      }
                      const result = yield* files.writeIfUnchanged({
                        sessionID: context.sessionID,
                        target: change.target,
                        expected: change.source,
                        content: change.content,
                        format: !change.mixed,
                      })
                      const diagnostics = yield* lsp.changed(result.target, context.sessionID)
                      applied.push({
                        ...(result.backup?.reversible === false ? { backup: result.backup } : {}),
                        ...(Object.keys(diagnostics.diagnostics).length || diagnostics.failed.length || diagnostics.pending?.length
                          ? { lsp: diagnostics }
                          : {}),
                        type: change.type,
                        resource: result.resource,
                        target: result.target,
                        ...(result.formatting ? { formatting: result.formatting } : {}),
                      })
                      patchFiles.push(patchFile({ ...change, after: result.content ?? change.after }))
                    }).pipe(Effect.mapError((error) => fail(change.path, error))),
                  { discard: true },
                )
                return { applied, files: patchFiles }
              }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : fail("patch", error))))
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/apply-patch",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, LSP.node, FSUtil.node, PermissionV2.node],
})

function patchFile(change: Prepared): typeof FileDiff.Info.Type {
  const counts = diffLines(change.before, change.after).reduce(
    (result, item) => ({
      additions: result.additions + (item.added ? (item.count ?? 0) : 0),
      deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
  return {
    file: change.target.resource,
    patch: createTwoFilesPatch(change.target.resource, change.target.resource, change.before, change.after),
    status: change.type === "add" ? "added" : change.type === "delete" ? "deleted" : "modified",
    ...counts,
  }
}
