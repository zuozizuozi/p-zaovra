export * as SessionAttachments from "./attachments"

import path from "path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { AgentV2 } from "../agent"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { FileAttachment } from "./prompt"

const snapshot = Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Schema.Array(Schema.NullOr(FileAttachment))))
const text = (file: FileAttachment, value: string): FileAttachment => ({
  ...file,
  mime: "text/plain",
  uri: `data:text/plain;base64,${Buffer.from(value).toString("base64")}`,
})

export class Service extends Context.Service<
  Service,
  {
    readonly materialize: (
      sessionID: SessionSchema.ID,
      agent: AgentV2.ID,
      messages: readonly SessionMessage.Message[],
    ) => Effect.Effect<SessionMessage.Message[]>
  }
>()("@zaovra/SessionAttachments") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    return Service.of({
      materialize: (sessionID, agent, messages) =>
        Effect.forEach(messages, (message) =>
          Effect.gen(function* () {
            if (message.type !== "user" || !message.files?.length) return message
            const key = createHash("sha256")
              .update(JSON.stringify([location, sessionID, message.id, message.files]))
              .digest("hex")
            const directory = path.join(global.data, "attachment-snapshots")
            const filename = path.join(directory, key)
            const cached = yield* fs.readFileStringSafe(filename).pipe(Effect.orDie)
            const saved =
              cached === undefined ? undefined : yield* Schema.decodeUnknownEffect(snapshot)(cached).pipe(Effect.orDie)
            const failed = new Set<number>()
            const files = yield* Effect.forEach(message.files, (file, index) =>
              Effect.gen(function* () {
                if (file.uri.startsWith("data:")) return file
                if (
                  /^[a-z][a-z0-9+.-]*:/i.test(file.uri) &&
                  !file.uri.startsWith("file:") &&
                  !/^[a-z]:[\\/]/i.test(file.uri)
                )
                  return yield* Effect.fail(
                    new Error(
                      "Unsupported attachment URI. Attach the file contents instead of a remote or resource URL.",
                    ),
                  )
                const input = yield* Effect.try({
                  try: () => (file.uri.startsWith("file:") ? fileURLToPath(file.uri) : file.uri),
                  catch: (cause) => new Error(`Invalid attachment path: ${String(cause)}`),
                })
                const target = yield* mutation.resolve({ path: input, kind: "directory" })
                const source = { type: "tool" as const, messageID: message.id, callID: `attachment_${index}` }
                if (target.externalDirectory)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
                    sessionID,
                    agent,
                    source,
                  })
                yield* permission.assert({
                  action: "read",
                  resources: [target.resource],
                  save: [target.resource],
                  sessionID,
                  agent,
                  source,
                })
                if (saved?.[index]) return saved[index]
                const stat = yield* fs.stat(target.canonical)
                if (stat.type === "Directory") {
                  const entries = (yield* fs.readDirectoryEntries(target.canonical)).sort((a, b) =>
                    a.name.localeCompare(b.name),
                  )
                  return text(
                    file,
                    `Directory: ${target.resource}\n${entries
                      .slice(0, 2000)
                      .map((entry) => entry.name + (entry.type === "directory" ? "/" : ""))
                      .join(
                        "\n",
                      )}${entries.length > 2000 ? "\n[Listing truncated; use read to page through remaining entries.]" : ""}`,
                  )
                }
                if (stat.type !== "File") return yield* Effect.fail(new Error("Attachment is not a regular file"))
                if (Number(stat.size) > 8 * 1024 * 1024)
                  return yield* Effect.fail(
                    new Error("Attachment exceeds 8 MiB; use read to retrieve a bounded range."),
                  )
                const bytes = yield* fs.readFile(target.canonical)
                if (file.mime.startsWith("text/") && bytes.includes(0))
                  return yield* Effect.fail(new Error("Binary attachment was declared as text"))
                return { ...file, uri: `data:${file.mime};base64,${Buffer.from(bytes).toString("base64")}` }
              }).pipe(
                Effect.catch((error) => {
                  failed.add(index)
                  return Effect.succeed(
                    text(
                      file,
                      `[Attachment unavailable: ${file.name ?? file.uri}] ${error instanceof Error ? error.message : String(error)}`,
                    ),
                  )
                }),
              ),
            )
            if (files.some((_, index) => !failed.has(index) && !saved?.[index])) {
              yield* fs.ensureDir(directory).pipe(Effect.orDie)
              const temporary = `${filename}.${crypto.randomUUID()}.tmp`
              yield* fs
                .writeFileString(
                  temporary,
                  yield* Schema.encodeEffect(snapshot)(
                    files.map((file, index) => (failed.has(index) ? (saved?.[index] ?? null) : file)),
                  ).pipe(Effect.orDie),
                  { mode: 0o600 },
                )
                .pipe(Effect.orDie)
              yield* fs.rename(temporary, filename).pipe(Effect.orDie)
            }
            return { ...message, files }
          }),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Global.node, FSUtil.node, Location.node, LocationMutation.node, PermissionV2.node],
})
