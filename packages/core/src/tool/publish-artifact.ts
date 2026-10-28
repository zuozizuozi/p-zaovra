export * as PublishArtifactTool from "./publish-artifact"

import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@zaovra-ai/llm"
import { makeLocationNode } from "../effect/app-node"
import { Database } from "../database/database"
import { FileMutation } from "../file-mutation"
import { FileBackup } from "../file-backup"
import { FSUtil } from "../fs-util"
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
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        publish_artifact: Tool.withPermission(
          Tool.make({
            description:
              "Atomically publish a validated candidate file in the same directory as the final artifact. Requires a current passing task check on the candidate; this is file delivery only, never deployment or sending. Keeps immutable old bytes at <final>.verified-<sha256>.bak before replacement. Candidate, final and backup must remain unchanged. No formatting is performed after validation.",
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
                    message: "Use distinct candidate and final files in the same workspace directory.",
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
                const targets = yield* SessionOutcome.fingerprint(
                  fs,
                  [...(check.targets ?? []), ...(check.assertions ?? [])].map((file) => file.path),
                )
                if (
                  !SessionOutcome.checkFreshness(check, targets).fresh ||
                  preliminary.checks.some(
                    (failed) =>
                      failed.exit !== 0 &&
                      !failed.supersededBy &&
                      failed.targets?.some((file) => file.path === candidate.canonical),
                  )
                )
                  return yield* new ToolFailure({
                    message: "Candidate evidence is stale or a relevant failure is still unresolved.",
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
  deps: [ToolRegistry.node, FileMutation.node, FSUtil.node, LocationMutation.node, Database.node, PermissionV2.node],
})
