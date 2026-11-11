export * as PublishArtifactTool from "./publish-artifact"

import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Layer, Option, Schema } from "effect"
import { ToolFailure } from "@zaovra-ai/llm"
import { makeLocationNode } from "../effect/app-node"
import { Database } from "../database/database"
import { FileMutation } from "../file-mutation"
import { FileBackup } from "../file-backup"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { SessionOutcome } from "../session/outcome"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const Input = Schema.Struct({
  candidate: Schema.String,
  path: Schema.String,
  check: Schema.String.annotate({
    description:
      "Fresh passing test/smoke check callID covering candidate and its assertions. Check parsing, integrity and explicit basic acceptance before publishing.",
  }),
  expectedDigest: Schema.NullOr(Schema.String).annotate({
    description:
      "SHA256 of the current final file, or null for create only. A changed final file is never overwritten.",
  }),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const database = yield* Database.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        publish_artifact: Tool.withPermission(
          Tool.make({
            description:
              "Atomically publish a validated candidate file in the same directory as the final artifact, consuming the candidate by rename. A passing check may cover several candidates published sequentially with the same callID; completed publications must retain their checked bytes. This is file delivery only, never deployment or sending. Keeps immutable old bytes at <final>.verified-<sha256>.bak before replacement. Candidate, final and backup must remain unchanged. No formatting is performed after validation.",
            input: Input,
            output: Schema.Struct({
              path: Schema.String,
              digest: Schema.String,
              backup: Schema.NullOr(Schema.String),
              undoBackup: FileBackup.Status.pipe(Schema.optional),
            }),
            toModelOutput: ({ output }) => [
              {
                type: "text",
                text: `Published ${output.path} (${output.digest}). Preserved previous artifact: ${output.backup ?? "no previous file"}. This certifies only the supplied check's actual scope.${output.undoBackup ? `\n${FileBackup.describe(output.undoBackup)}` : ""}`,
              },
            ],
            execute: (input, context) =>
              Effect.gen(function* () {
                const candidate = yield* mutation.resolve({ path: input.candidate, kind: "file" })
                const target = yield* mutation.resolve({ path: input.path, kind: "file" })
                if (
                  candidate.externalDirectory ||
                  target.externalDirectory ||
                  path.dirname(candidate.canonical) !== path.dirname(target.canonical) ||
                  candidate.canonical === target.canonical
                )
                  return yield* new ToolFailure({
                    message: `Candidate ${input.candidate} and final ${input.path} must be different files in the same workspace directory. For example, use gpt/guide.pdf.candidate → gpt/guide.pdf, not gpt/.publish-candidates/guide.pdf → gpt/guide.pdf. Move the candidate first, then rerun its check at the new path.`,
                  })
                if (input.expectedDigest !== null && !/^[a-f0-9]{64}$/.test(input.expectedDigest))
                  return yield* new ToolFailure({ message: "expectedDigest must be an observed SHA256 or null." })
                const backup = yield* mutation.resolve({
                  path: target.canonical + `.verified-${input.expectedDigest ?? "new"}.bak`,
                  kind: "file",
                })
                if (backup.externalDirectory)
                  return yield* new ToolFailure({ message: "Backup must stay inside the workspace." })
                yield* permission.assert({
                  action: "edit",
                  resources: [candidate.resource, target.resource, backup.resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const validate = Effect.gen(function* () {
                  for (const original of [candidate, target]) {
                    const current = yield* mutation
                      .resolve({ path: original.canonical, kind: "file" })
                      .pipe(Effect.mapError(() => new FileMutation.TargetChangedError({ path: original.canonical })))
                    if (
                      current.identity !== original.identity ||
                      current.canonical !== original.canonical ||
                      current.externalDirectory
                    )
                      return yield* new FileMutation.TargetChangedError({ path: original.canonical })
                  }
                })
                yield* validate
                const history = yield* SessionOutcome.history(database.db, context.sessionID)
                const preliminary = SessionOutcome.derive(history, true)
                const check = preliminary.checks.find(
                  (check) =>
                    check.callID === input.check &&
                    check.exit === 0 &&
                    !check.execution &&
                    !check.supersededBy &&
                    ["test", "smoke", "interaction"].includes(check.kind),
                )
                if (
                  !check?.targets?.some((file) => file.path === candidate.canonical && file.digest) ||
                  !check.requirements?.length
                )
                  return yield* new ToolFailure({
                    message:
                      "Unverified candidate: supply a passing task-specific check with candidate in verification_targets and explicit verification_requirements.",
                  })
                // Publishing consumes a candidate by rename. Only a later, durable successful
                // publication under this exact check can explain that change; rehash its final.
                const parts = history.flatMap((message) => (message.type === "assistant" ? message.content : []))
                const checked = parts.findIndex((part) => part.type === "tool" && part.id === check.callID)
                const receipts = parts.slice(checked + 1).flatMap((part) => {
                  if (
                    checked < 0 ||
                    part.type !== "tool" ||
                    part.name !== "publish_artifact" ||
                    part.provider?.executed ||
                    part.state.status !== "completed"
                  )
                    return []
                  const previous = Schema.decodeUnknownOption(Input)(part.state.input)
                  const output = Schema.decodeUnknownOption(
                    Schema.Struct({ path: Schema.String, digest: Schema.String }),
                  )(part.state.structured)
                  if (Option.isNone(previous) || Option.isNone(output) || previous.value.check !== check.callID)
                    return []
                  const source = path.resolve(location.directory, previous.value.candidate)
                  const final = path.resolve(location.directory, previous.value.path)
                  if (
                    source === final ||
                    path.dirname(source) !== path.dirname(final) ||
                    path.resolve(location.directory, output.value.path) !== final ||
                    !check.targets?.some((file) => file.path === source && file.digest === output.value.digest)
                  )
                    return []
                  return [{ source, final, digest: output.value.digest, expected: previous.value.expectedDigest }]
                })
                const targets = yield* SessionOutcome.fingerprint(fs, [
                  ...[...(check.targets ?? []), ...(check.assertions ?? [])].map((file) => file.path),
                  ...receipts.map((receipt) => receipt.final),
                ])
                const missing = yield* Effect.forEach(receipts, (receipt) =>
                  fs.stat(receipt.source).pipe(
                    Effect.as(false),
                    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(true)),
                    Effect.map((absent) => (absent ? receipt.source : undefined)),
                  ),
                )
                const freshness = SessionOutcome.checkFreshness(
                  check,
                  targets.map((current) => {
                    const original = check.targets?.find((file) => file.path === current.path)
                    if (!original?.digest || current.digest === original.digest) return current
                    const published = receipts.some(
                      (receipt) =>
                        targets.some((file) => file.path === receipt.final && file.digest === receipt.digest) &&
                        ((current.path === receipt.source &&
                          missing.includes(receipt.source) &&
                          !current.digest &&
                          original.digest === receipt.digest) ||
                          (current.path === receipt.final && original.digest === receipt.expected)),
                    )
                    return published ? { ...current, digest: original.digest } : current
                  }),
                )
                if (!freshness.fresh)
                  return yield* new ToolFailure({
                    message: `Check ${input.check} is stale: ${freshness.changedTargets.join(", ")}. Rerun the full check with the current candidate and all original dependencies, then use its new callID. For example, check gpt/garden.png.candidate before publishing it to gpt/garden.png; do not drop changed targets from the check.`,
                  })
                if (
                  preliminary.checks.some(
                    (failed) =>
                      failed.exit !== 0 &&
                      !failed.supersededBy &&
                      failed.targets?.some((file) => file.path === candidate.canonical),
                  )
                )
                  return yield* new ToolFailure({
                    message: `An unresolved failed check still covers ${input.candidate}. Fix that failure and rerun the same verification scope before publishing; for example, rerun the failed PNG integrity check on gpt/garden.png.candidate, then use the passing callID. A narrower unrelated check does not resolve it.`,
                  })
                const info = yield* fs.stat(candidate.canonical)
                if (info.type !== "File" || info.size > 64 * 1024 * 1024)
                  return yield* new ToolFailure({
                    message: "Candidate is not a regular file within the 64 MiB publish limit.",
                  })
                const verified = yield* fs.readFile(candidate.canonical)
                const digest = createHash("sha256").update(verified).digest("hex")
                if (!check.targets.some((file) => file.path === candidate.canonical && file.digest === digest))
                  return yield* new ToolFailure({ message: "Candidate changed after its check." })
                const expected = yield* fs
                  .readFile(target.canonical)
                  .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)))
                if (
                  (expected === null ? null : createHash("sha256").update(expected).digest("hex")) !==
                  input.expectedDigest
                )
                  return yield* new ToolFailure({ message: "Final artifact changed; inspect it before publishing." })
                const result = yield* files.publish({
                  target,
                  candidate,
                  backup,
                  verified,
                  expected,
                  validate,
                  sessionID: context.sessionID,
                })
                return {
                  path: target.resource,
                  digest,
                  backup: expected === null ? null : backup.resource,
                  ...(result.backup?.reversible === false ? { undoBackup: result.backup } : {}),
                }
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure
                    ? error
                    : new ToolFailure({ message: `Artifact was not published: ${error.message}` }),
                ),
              ),
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/publish-artifact",
  layer,
  deps: [
    Location.node,
    ToolRegistry.node,
    FileMutation.node,
    FSUtil.node,
    LocationMutation.node,
    Database.node,
    PermissionV2.node,
  ],
})
