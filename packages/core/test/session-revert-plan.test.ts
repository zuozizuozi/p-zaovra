import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { DateTime, Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { FileMutation } from "../src/file-mutation"
import { Global } from "../src/global"
import { LocationMutation } from "../src/location-mutation"
import { LocationServiceMap } from "../src/location-service-map"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath, RelativePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { SessionMessageTable } from "../src/session/sql"
import { Snapshot } from "../src/snapshot"
import { Hash } from "../src/util/hash"
import { tmpdir } from "./fixture/tmpdir"

for (const git of [false, true])
  test(`789 real restore selection and file lifecycle (git=${git})`, async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    const expected = (git ? ["command.txt", "tool.txt"] : ["tool.txt"]).map((file) => RelativePath.make(file))
    await fs.mkdir(directory)
    await Bun.write(path.join(directory, "tool.txt"), "before\n")
    if (git) {
      for (const args of [
        ["init", "--quiet"],
        ["add", "."],
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@zaovra.test",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--quiet",
          "-m",
          "fixture",
        ],
      ]) {
        const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
        const [out, err, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(exit, out + err).toBe(0)
      }
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const locations = yield* LocationServiceMap.Service
        const sessionID = SessionV2.ID.make("ses_revert789")
        const messageID = SessionMessage.ID.make("msg_revert789")
        yield* sessions.create({ id: sessionID, location: { directory: AbsolutePath.make(directory) } })
        yield* sessions.prompt({ sessionID, id: messageID, prompt: { text: "fixture task" }, resume: false })
        yield* SessionInput.promoteSteers(database.db, events, sessionID, Number.MAX_SAFE_INTEGER)
        const boundary = yield* database.db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        if (!boundary) throw new Error("Promoted fixture message missing")
        const coldFiles = yield* Effect.promise(() => fingerprint(tmp.path))
        const coldRows = yield* database.db.select().from(SessionMessageTable).all().pipe(Effect.orDie)
        expect((yield* sessions.revert.plan({ sessionID, messageID })).files).toEqual([])
        expect(yield* Effect.promise(() => fingerprint(tmp.path))).toEqual(coldFiles)
        expect(yield* database.db.select().from(SessionMessageTable).all().pipe(Effect.orDie)).toEqual(coldRows)
        const session = yield* sessions.get(sessionID)
        const snapshots = yield* Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          const mutation = yield* FileMutation.Service
          const targets = yield* LocationMutation.Service
          const start = yield* snapshot.capture({ sessionID })
          expect(start).toBeDefined()
          const target = yield* targets.resolve({ path: "tool.txt" })
          yield* mutation.writeTextPreservingBom({ sessionID, target, content: "tool write\n", expected: "before\n" })
          // A real child-process write bypasses FileMutation, as command-line tools do.
          const child = Bun.spawn([process.execPath, "-e", "await Bun.write('command.txt', 'command write\\n')"], {
            cwd: directory,
            stdout: "pipe",
            stderr: "pipe",
          })
          expect(yield* Effect.promise(() => child.exited)).toBe(0)
          const end = yield* snapshot.capture({ sessionID })
          if (!start || !end) throw new Error("Snapshot fixture unavailable")
          const files = yield* snapshot.files({ from: start, to: end })
          expect([...files].sort()).toEqual(expected)
          return { start, end, files }
        }).pipe(Effect.provide(locations.get(session.location)))
        const append = (id: string, seq: number, files = snapshots.files) =>
          Effect.gen(function* () {
            const message = Schema.encodeSync(SessionMessage.Message)(
              SessionMessage.Assistant.make({
                id: SessionMessage.ID.make(id),
                type: "assistant",
                agent: "build",
                model: { id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("fixture") },
                content: [],
                time: { created: DateTime.makeUnsafe(seq) },
                snapshot: { ...snapshots, files },
              }),
            )
            const { id: messageID, type, ...data } = message
            yield* database.db
              .insert(SessionMessageTable)
              .values({ id: SessionMessage.ID.make(messageID), session_id: sessionID, type, seq, data })
              .run()
              .pipe(Effect.orDie)
          })
        yield* append("msg_assistant789", boundary.seq + 1)
        const before = yield* Effect.promise(() => fingerprint(tmp.path))
        const rows = yield* database.db.select().from(SessionMessageTable).all().pipe(Effect.orDie)
        const plan = yield* sessions.revert.plan({ sessionID, messageID })
        expect(plan.files).toEqual(expected)
        expect(plan.coverage).toBe(git ? "snapshot" : "file-tools")
        expect(yield* sessions.revert.plan({ sessionID, messageID })).toEqual(plan)
        expect(yield* Effect.promise(() => fingerprint(tmp.path))).toEqual(before)
        expect(yield* database.db.select().from(SessionMessageTable).all().pipe(Effect.orDie)).toEqual(rows)
        expect((yield* sessions.get(sessionID)).revert).toBeUndefined()
        // Merely previewing/cancelling has not restored files or hidden messages.
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "tool.txt")).text())).toBe("tool write\n")
        yield* sessions.revert.stage({ sessionID, messageID, planToken: plan.token })
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "tool.txt")).text())).toBe("before\n")
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "command.txt")).exists())).toBe(!git)
        expect((yield* sessions.get(sessionID)).revert?.messageID).toBe(messageID)
        yield* sessions.revert.clear(sessionID)
        expect((yield* sessions.get(sessionID)).revert).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "tool.txt")).text())).toBe("tool write\n")
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "command.txt")).text())).toBe(
          "command write\n",
        )
        const fresh = yield* sessions.revert.plan({ sessionID, messageID })
        yield* append("msg_later789", boundary.seq + 2, [...snapshots.files, RelativePath.make("later.txt")])
        expect(
          yield* sessions.revert.stage({ sessionID, messageID, planToken: fresh.token }).pipe(Effect.flip),
        ).toBeInstanceOf(SessionV2.RevertPlanChangedError)
        expect((yield* sessions.get(sessionID)).revert).toBeUndefined()
        yield* database.db
          .delete(SessionMessageTable)
          .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_later789")))
          .run()
          .pipe(Effect.orDie)
        if (!git) {
          yield* Effect.promise(() => Bun.write(path.join(directory, "tool.txt"), "external write\n"))
          const external = yield* sessions.revert.plan({ sessionID, messageID })
          const failure = yield* sessions.revert
            .stage({ sessionID, messageID, planToken: external.token })
            .pipe(Effect.flip)
          expect(failure).toBeInstanceOf(Snapshot.Error)
          expect(failure.message).toContain("changed")
          expect((yield* sessions.get(sessionID)).revert).toBeUndefined()
          expect(yield* Effect.promise(() => Bun.file(path.join(directory, "tool.txt")).text())).toBe(
            "external write\n",
          )
          yield* Effect.promise(() => Bun.write(path.join(directory, "tool.txt"), "tool write\n"))
        }
        const finalPlan = yield* sessions.revert.plan({ sessionID, messageID })
        yield* sessions.revert.stage({ sessionID, messageID, planToken: finalPlan.token })
        yield* sessions.revert.commit(sessionID)
        expect((yield* sessions.get(sessionID)).revert).toBeUndefined()
        expect(
          yield* database.db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all().pipe(Effect.orDie),
        ).toEqual([{ id: messageID }])
        yield* sessions.revert.clear(sessionID)
        expect(
          yield* database.db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all().pipe(Effect.orDie),
        ).toEqual([{ id: messageID }])
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([SessionV2.node, EventV2.node, Database.node, LocationServiceMap.node]),
            [
              [Database.node, Database.layerFromPath(":memory:")],
              [
                Global.node,
                Global.layerWith({ data: path.join(tmp.path, "data"), config: path.join(tmp.path, "config") }),
              ],
              [SessionExecution.node, SessionExecution.noopLayer],
            ],
          ),
        ),
      ),
    )
  }, 60_000)

async function fingerprint(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) return fingerprint(file)
      return [file + ":" + Hash.sha256(Buffer.from(await Bun.file(file).arrayBuffer()))]
    }),
  )
  return files.flat().sort()
}
