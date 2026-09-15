export * as Evidence from "./evidence"

import path from "path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { BackgroundJob } from "./background-job"
import { Global } from "./global"
import { makeLocationNode } from "./effect/app-node"
import { SessionSchema } from "./session/schema"
import { ToolOutputStore } from "./tool-output-store"

const Record = Schema.Struct({
  sessionID: Schema.String,
  toolCallID: Schema.String,
  file: Schema.String,
  created: Schema.Number,
  jobID: Schema.optional(Schema.String),
})
const RecordJson = Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Record))
export const reference = (sessionID: string, file: string) =>
  `ev_${createHash("sha256")
    .update(JSON.stringify([sessionID, file]))
    .digest("hex")}`
export class Error extends Schema.TaggedErrorClass<Error>()("Evidence.Error", { message: Schema.String }) {}
export interface Page {
  readonly producer: "complete" | "writing" | "outcome_unknown"
  readonly id: string
  readonly offset: number
  readonly nextOffset?: number
  readonly snapshotBytes: number
  readonly text: string
  readonly matches?: readonly { offset: number; text: string }[]
}
export class Service extends Context.Service<
  Service,
  {
    readonly retain: (
      sessionID: SessionSchema.ID,
      toolCallID: string,
      files: readonly string[],
      jobID?: string,
    ) => Effect.Effect<string[], Error>
    readonly read: (
      sessionID: SessionSchema.ID,
      id: string,
      offset: number,
      length: number,
      query?: string,
    ) => Effect.Effect<Page, Error>
  }
>()("@zaovra/Evidence") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const jobs = yield* BackgroundJob.Service
    const directory = path.join(global.data, ToolOutputStore.MANAGED_DIRECTORY)
    return Service.of({
      retain: (sessionID, toolCallID, files, jobID) =>
        Effect.tryPromise({
          try: async () =>
            Promise.all(
              files.map(async (file) => {
                if (path.dirname(file) !== directory || !/^tool_[a-zA-Z0-9_-]+$/.test(path.basename(file)))
                  throw new Error({ message: "Unmanaged evidence source" })
                const id = reference(sessionID, file)
                const record = { sessionID, toolCallID, file: path.basename(file), created: Date.now(), jobID }
                await fs
                  .writeFile(path.join(directory, id), JSON.stringify(record), { flag: "wx", mode: 0o600 })
                  .catch((error: NodeJS.ErrnoException) => {
                    if (error.code !== "EEXIST") throw error
                  })
                return id
              }),
            ),
          catch: (error) => new Error({ message: `Evidence retention failed: ${String(error)}` }),
        }),
      read: (sessionID, id, offset, length, query) =>
        Effect.tryPromise({
          try: async () => {
            if (!/^ev_[a-f0-9]{64}$/.test(id)) throw new Error({ message: "Invalid Evidence ID" })
            if (
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              !Number.isSafeInteger(length) ||
              length < 1 ||
              length > 32768
            )
              throw new Error({ message: "Invalid byte range (maximum 32768 bytes)" })
            const record = Schema.decodeUnknownSync(RecordJson)(await fs.readFile(path.join(directory, id), "utf8"))
            if (record.sessionID !== sessionID) throw new Error({ message: "Evidence is not owned by this session" })
            if (!/^tool_[a-zA-Z0-9_-]+$/.test(record.file)) throw new Error({ message: "Invalid evidence source" })
            const job = record.jobID ? await Effect.runPromise(jobs.get(record.jobID)) : undefined
            const producer = !record.jobID
              ? ("complete" as const)
              : !job
                ? ("outcome_unknown" as const)
                : job.status === "running"
                  ? ("writing" as const)
                  : ("complete" as const)
            const handle = await fs.open(path.join(directory, record.file), "r")
            try {
              const stat = await handle.stat()
              if (Date.now() - stat.mtimeMs > 7 * 86400000) throw new Error({ message: "Evidence expired" })
              const buffer = Buffer.alloc(Math.min(length, Math.max(0, stat.size - offset)))
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
              const bytes = buffer.subarray(0, bytesRead)
              const decoded = new TextDecoder("utf-8", { fatal: true })
              // Hold an incomplete trailing UTF-8 character for the next page.
              const value = decoded.decode(bytes, { stream: offset + bytesRead < stat.size })
              const consumed = Buffer.byteLength(value)
              if (!consumed && bytesRead)
                throw new Error({ message: "Increase the range to include a complete UTF-8 character" })
              const nextOffset = offset + consumed < stat.size ? offset + consumed : undefined
              if (query === undefined)
                return { producer, id, offset, nextOffset, snapshotBytes: stat.size, text: value }
              if (!query.length || Buffer.byteLength(query) > 1024)
                throw new Error({ message: "Search requires a nonempty literal up to 1024 bytes" })
              const matches: { offset: number; text: string }[] = []
              let cursor = 0
              while (matches.length < 30) {
                const found = value.indexOf(query, cursor)
                if (found < 0) break
                matches.push({
                  offset: offset + Buffer.byteLength(value.slice(0, found)),
                  text: value.slice(Math.max(0, found - 120), found + query.length + 120),
                })
                cursor = found + query.length
              }
              const resume =
                matches.length === 30
                  ? offset + Buffer.byteLength(value.slice(0, cursor))
                  : nextOffset === undefined
                    ? undefined
                    : offset + Buffer.byteLength(value.slice(0, Math.max(1, value.length - query.length + 1)))
              return {
                producer,
                id,
                offset,
                nextOffset: resume,
                snapshotBytes: stat.size,
                text: "Literal search of this byte range; continue at nextOffset to search the rest.",
                matches,
              }
            } finally {
              await handle.close()
            }
          },
          catch: (error) =>
            new Error({ message: error instanceof Error ? error.message : `Evidence unavailable: ${String(error)}` }),
        }),
    })
  }),
)
export const node = makeLocationNode({ service: Service, layer, deps: [Global.node, BackgroundJob.node] })
