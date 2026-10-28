import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
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

const directory = AbsolutePath.make(path.resolve(process.argv[3]))
const sessionID = SessionV2.ID.make("ses_nongit_integration")
const messageID = SessionMessage.ID.make("msg_nongit_user")
await Effect.runPromise(
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const global = yield* Global.Service
    if (process.argv[2] === "write") {
      yield* sessions.create({
        id: sessionID,
        location: { directory },
        model: { id: ModelV2.ID.make("audit-model"), providerID: ProviderV2.ID.make("audit") },
      })
      yield* sessions.prompt({
        sessionID,
        id: messageID,
        prompt: { text: "Update existing.txt and create new.txt using the write tool." },
        resume: false,
      })
      yield* sessions.resume(sessionID)
      const result = {
        messages: yield* sessions.context(sessionID),
        diffs: yield* sessions.turnDiff({ sessionID, messageID }),
      }
      yield* Effect.promise(() => Bun.write(path.join(directory, "write-evidence.json"), JSON.stringify(result)))
      return
    }
    const before = yield* sessions.turnDiff({ sessionID, messageID })
    yield* sessions.revert.stage({ sessionID, messageID, files: true })
    const undone = {
      existing: yield* Effect.promise(() => Bun.file(path.join(directory, "existing.txt")).text()),
      newExists: yield* Effect.promise(() => Bun.file(path.join(directory, "new.txt")).exists()),
    }
    yield* sessions.revert.clear(sessionID)
    const redone = {
      existing: yield* Effect.promise(() => Bun.file(path.join(directory, "existing.txt")).text()),
      new: yield* Effect.promise(() => Bun.file(path.join(directory, "new.txt")).text()),
    }
    const backupFolder = FileBackup.directory(global.data, sessionID)
    const hadBackup = yield* Effect.promise(() => fs.stat(backupFolder).then(() => true))
    yield* sessions.remove(sessionID)
    const cleaned = yield* Effect.promise(() =>
      fs.stat(backupFolder).then(
        () => false,
        () => true,
      ),
    )
    yield* Effect.promise(() =>
      Bun.write(
        path.join(directory, "restore-evidence.json"),
        JSON.stringify({ before, undone, redone, hadBackup, cleaned }),
      ),
    )
  }).pipe(
    Effect.timeout("45 seconds"),
    Effect.scoped,
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([SessionV2.node, EventV2.node, Database.node, Global.node]), [
        [Database.node, Database.layerFromPath(path.join(directory, "sessions.db"))],
        [SessionExecution.node, SessionExecutionLocal.node],
      ]),
    ),
  ),
)
