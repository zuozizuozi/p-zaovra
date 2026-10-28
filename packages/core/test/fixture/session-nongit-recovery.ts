import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "../../src/effect/layer-node"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { SessionV2 } from "../../src/session"
import { SessionExecution } from "../../src/session/execution"
import { SessionExecutionLocal } from "../../src/session/execution/local"
import { SessionMessage } from "../../src/session/message"
import { AbsolutePath } from "../../src/schema"
import { ModelV2 } from "../../src/model"
import { ProviderV2 } from "../../src/provider"
import { FileBackup } from "../../src/file-backup"
import { Global } from "../../src/global"
import { FSUtil } from "../../src/fs-util"

const directory = AbsolutePath.make(path.resolve(process.argv[3]))
const sessionID = SessionV2.ID.make("ses_recovery_integration")
const messageID = SessionMessage.ID.make("msg_recovery")
const mode = process.argv[4]
const target = path.join(directory, "target.txt")
let armed = process.argv[2] === "reject"
const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      rename: (from, to) =>
        fs.rename(from, to).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              if (!armed || mode === "interrupt" || path.basename(to) !== "journal.json") return
              const journal = yield* fs.readJson(to).pipe(Effect.orDie)
              if (
                !journal ||
                typeof journal !== "object" ||
                !("pending" in journal) ||
                !Array.isArray(journal.pending) ||
                !journal.pending.length
              )
                return
              armed = false
              yield* Effect.promise(() => Bun.write(target, "external"))
            }),
          ),
        ),
      open: (file, options) =>
        fs.open(file, options).pipe(
          Effect.map((handle) =>
            file !== target || !armed || mode !== "interrupt"
              ? handle
              : new Proxy(handle, {
                  get(object, key) {
                    if (key !== "writeAll") return Reflect.get(object, key)
                    return () =>
                      handle.writeAll(new TextEncoder().encode("partial unknown")).pipe(
                        Effect.andThen(
                          Effect.sync(() => {
                            // Terminate only this isolated child after a real partial write, before settlement.
                            process.exit(73)
                          }),
                        ),
                      )
                  },
                }),
          ),
        ),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const read = async (file: string) =>
  Bun.file(file)
    .exists()
    .then((exists) => (exists ? Bun.file(file).text() : null))
await Effect.runPromise(
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const global = yield* Global.Service
    if (process.argv[2] === "reject") {
      yield* sessions.create({
        id: sessionID,
        location: { directory },
        model: { id: ModelV2.ID.make("audit-model"), providerID: ProviderV2.ID.make("audit") },
      })
      yield* sessions.prompt({
        sessionID,
        id: SessionMessage.ID.make("msg_rejected"),
        prompt: { text: "Change target.txt using the requested tool." },
        resume: false,
      })
      yield* sessions.resume(sessionID)
      yield* Effect.promise(() =>
        Bun.write(path.join(directory, "rejected.json"), JSON.stringify({ messages: undefined, diffs: undefined })),
      )
      const messages = yield* sessions.context(sessionID)
      const diffs = yield* sessions.turnDiff({ sessionID, messageID: SessionMessage.ID.make("msg_rejected") })
      yield* Effect.promise(() => Bun.write(path.join(directory, "rejected.json"), JSON.stringify({ messages, diffs })))
      return
    }
    const file = mode === "interrupt" ? path.join(directory, "healthy.txt") : target
    yield* sessions.prompt({
      sessionID,
      id: messageID,
      prompt: {
        text: "Create healthy.txt after the interrupted write, or safely update target.txt after the rejected write. Do not retry the old operation.",
      },
      resume: false,
    })
    yield* sessions.resume(sessionID)
    const diffs = yield* sessions.turnDiff({ sessionID, messageID })
    yield* sessions.revert.stage({ sessionID, messageID, files: true })
    const undone = yield* Effect.promise(() => read(file))
    yield* sessions.revert.clear(sessionID)
    const redone = yield* Effect.promise(() => read(file))
    const folder = FileBackup.directory(global.data, sessionID)
    const placements = yield* Effect.promise(() => fs.readdir(folder))
    const journal = yield* Effect.promise(() => Bun.file(path.join(folder, placements[0], "journal.json")).json())
    const pendingOriginal =
      mode === "interrupt"
        ? yield* Effect.promise(() => Bun.file(path.join(folder, placements[0], journal.pending[0].before.hash)).text())
        : null
    const uncertainEntries = journal.entries.filter((item: { path: string }) => item.path === "target.txt").length
    if (mode === "interrupt") {
      yield* sessions.prompt({
        sessionID,
        id: SessionMessage.ID.make("msg_isolated"),
        prompt: { text: "Attempt an explicit write of target.txt; preserve its isolation if unfinished." },
        resume: false,
      })
      yield* sessions.resume(sessionID)
    }
    const context = yield* sessions.context(sessionID)
    const tools = context.flatMap((message) =>
      message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
    )
    const isolatedRejected = mode === "interrupt" && tools.at(-1)?.state.status !== "completed"
    const original = yield* Effect.promise(() => read(target))
    yield* sessions.remove(sessionID)
    const cleaned = yield* Effect.promise(() =>
      fs.stat(folder).then(
        () => false,
        () => true,
      ),
    )
    yield* Effect.promise(() =>
      Bun.write(
        path.join(directory, "recovery-evidence.json"),
        JSON.stringify({
          diffs,
          undone,
          redone,
          original,
          pending: journal.pending?.length ?? 0,
          pendingOriginal,
          uncertainEntries,
          isolatedRejected,
          cleaned,
        }),
      ),
    )
  }).pipe(
    Effect.timeout("45 seconds"),
    Effect.scoped,
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([SessionV2.node, EventV2.node, Database.node, Global.node]), [
        [Database.node, Database.layerFromPath(path.join(directory, "sessions.db"))],
        [SessionExecution.node, SessionExecutionLocal.node],
        [FSUtil.node, filesystem],
      ]),
    ),
  ),
)
