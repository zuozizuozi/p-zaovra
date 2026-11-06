import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { AbsolutePath } from "../src/schema"
import { Global } from "../src/global"
import { tmpdir } from "./fixture/tmpdir"

test("700 non-Git message-only revert clears without restoring an empty snapshot", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "keep.txt"), "untouched")
  await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_revert_empty700")
      const messageID = SessionMessage.ID.make("msg_revert_empty700")
      yield* sessions.create({ id: sessionID, location: { directory: AbsolutePath.make(tmp.path) } })
      yield* sessions.prompt({ sessionID, id: messageID, prompt: { text: "keep files" }, resume: false })
      yield* SessionInput.promoteSteers(database.db, events, sessionID, Number.MAX_SAFE_INTEGER)
      yield* sessions.revert.stage({ sessionID, messageID, files: false })
      expect((yield* sessions.get(sessionID)).revert?.files).toEqual([])
      yield* sessions.revert.clear(sessionID)
      expect((yield* sessions.get(sessionID)).revert).toBeUndefined()
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "keep.txt")).text())).toBe("untouched")
    }).pipe(
      Effect.scoped,
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([SessionV2.node, EventV2.node, Database.node, Global.node]), [
          [Database.node, Database.layerFromPath(":memory:")],
          [SessionExecution.node, SessionExecution.noopLayer],
        ]),
      ),
    ),
  )
}, 30000)
