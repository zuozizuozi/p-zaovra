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
const sessionID = SessionV2.ID.make("ses_publish_integration")
const messageID = SessionMessage.ID.make("msg_publish_user")
const read = async (name: string) =>
  Bun.file(path.join(directory, name))
    .exists()
    .then((exists) => (exists ? Bun.file(path.join(directory, name)).text() : null))
await Effect.runPromise(
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const global = yield* Global.Service
    if (process.argv[2] === "publish") {
      yield* sessions.create({
        id: sessionID,
        location: { directory },
        model: { id: ModelV2.ID.make("audit-model"), providerID: ProviderV2.ID.make("audit") },
      })
      if (process.argv[4] === "true") {
        yield* sessions.prompt({
          sessionID,
          id: SessionMessage.ID.make("msg_seed"),
          prompt: { text: "Write candidate.json as [1,2] then stop." },
          resume: false,
        })
        yield* sessions.resume(sessionID)
      }
      yield* sessions.prompt({
        sessionID,
        id: messageID,
        prompt: {
          text: "Deliver final.json. Write candidate if absent, run task_check.cjs to assert it, then publish the verified artifact.",
        },
        resume: false,
      })
      yield* sessions.resume(sessionID)
      const messages = yield* sessions.context(sessionID)
      const tools = messages.flatMap((message) =>
        message.type === "assistant"
          ? message.content.flatMap((part) =>
              part.type === "tool" ? [{ name: part.name, status: part.state.status, state: part.state }] : [],
            )
          : [],
      )
      yield* Effect.promise(() =>
        Bun.write(path.join(directory, "publish-evidence.json"), JSON.stringify({ diffs: undefined, tools, messages })),
      )
      const diffs = yield* sessions.turnDiff({ sessionID, messageID })
      yield* Effect.promise(() =>
        Bun.write(path.join(directory, "publish-evidence.json"), JSON.stringify({ diffs, tools, messages })),
      )
      return
    }
    if (process.argv[2] === "restore") {
      yield* sessions.revert.stage({ sessionID, messageID, files: true })
      const undone = {
        candidate: yield* Effect.promise(() => read("candidate.json")),
        final: yield* Effect.promise(() => read("final.json")),
      }
      yield* sessions.revert.clear(sessionID)
      const redone = {
        candidate: yield* Effect.promise(() => read("candidate.json")),
        final: yield* Effect.promise(() => read("final.json")),
      }
      yield* Effect.promise(() =>
        Bun.write(path.join(directory, "restore-evidence.json"), JSON.stringify({ undone, redone })),
      )
      return
    }
    yield* Effect.promise(() => Bun.write(path.join(directory, "final.json"), "external"))
    const result = yield* sessions.revert.stage({ sessionID, messageID, files: true }).pipe(Effect.result)
    const final = yield* Effect.promise(() => read("final.json"))
    const candidate = yield* Effect.promise(() => read("candidate.json"))
    const backupFolder = FileBackup.directory(global.data, sessionID)
    yield* sessions.remove(sessionID)
    const cleaned = yield* Effect.promise(() =>
      fs.stat(backupFolder).then(
        () => false,
        () => true,
      ),
    )
    yield* Effect.promise(() =>
      Bun.write(
        path.join(directory, "conflict-evidence.json"),
        JSON.stringify({ rejected: result._tag === "Failure", final, candidate, cleaned }),
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
