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
import { tmpdir } from "./fixture/tmpdir"

for (const git of [false, true])
  for (const action of ["normal", "clear-edit", "stage-edit", "clear-create", "stage-delete"] as const)
    test(
      "799 session restore protects external files: git=" + git + ", action=" + action,
      async () => {
        await using tmp = await tmpdir()
        const directory = path.join(tmp.path, "project")
        await fs.mkdir(directory)
        await Bun.write(path.join(directory, "a.txt"), "before\n")
        await Bun.write(path.join(directory, "z.txt"), "before z\n")
        if (git)
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
            const [out, err, code] = await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              child.exited,
            ])
            expect(code, out + err).toBe(0)
          }
        await Effect.runPromise(
          Effect.gen(function* () {
            const sessions = yield* SessionV2.Service
            const database = yield* Database.Service
            const events = yield* EventV2.Service
            const locations = yield* LocationServiceMap.Service
            const sessionID = SessionV2.ID.make("ses_restore799")
            const messageID = SessionMessage.ID.make("msg_human799")
            yield* sessions.create({ id: sessionID, location: { directory: AbsolutePath.make(directory) } })
            yield* sessions.prompt({ sessionID, id: messageID, prompt: { text: "change files" }, resume: false })
            yield* SessionInput.promoteSteers(database.db, events, sessionID, Number.MAX_SAFE_INTEGER)
            const boundary = yield* database.db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(eq(SessionMessageTable.id, messageID))
              .get()
              .pipe(Effect.orDie)
            if (!boundary) throw new Error("Human boundary missing")
            const session = yield* sessions.get(sessionID)
            const snapshots = yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              const mutation = yield* FileMutation.Service
              const targets = yield* LocationMutation.Service
              const start = yield* snapshot.capture({ sessionID })
              yield* mutation.writeTextPreservingBom({
                sessionID,
                target: yield* targets.resolve({ path: "a.txt" }),
                content: "after\n",
                expected: "before\n",
              })
              yield* mutation.writeTextPreservingBom({
                sessionID,
                target: yield* targets.resolve({ path: "z.txt" }),
                content: "after z\n",
                expected: "before z\n",
              })
              yield* mutation.create({
                sessionID,
                target: yield* targets.resolve({ path: "new.txt" }),
                content: "created\n",
              })
              const end = yield* snapshot.capture({ sessionID })
              if (!start || !end) throw new Error("Snapshot unavailable")
              return { start, end, files: yield* snapshot.files({ from: start, to: end }) }
            }).pipe(Effect.provide(locations.get(session.location)))
            const encoded = Schema.encodeSync(SessionMessage.Message)(
              SessionMessage.Assistant.make({
                id: SessionMessage.ID.make("msg_assistant799"),
                type: "assistant",
                agent: "build",
                model: { id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("fixture") },
                content: [],
                time: { created: DateTime.makeUnsafe(20) },
                snapshot: snapshots,
              }),
            )
            const { id, type, ...data } = encoded
            yield* database.db
              .insert(SessionMessageTable)
              .values({
                id: SessionMessage.ID.make(id),
                session_id: sessionID,
                type,
                seq: boundary.seq + 1,
                data,
              })
              .run()
              .pipe(Effect.orDie)
            const plan = yield* sessions.revert.plan({ sessionID, messageID })
            expect(plan.files).toEqual(["a.txt", "new.txt", "z.txt"].map((file) => RelativePath.make(file)))
            yield* sessions.revert.stage({ sessionID, messageID, planToken: plan.token })
            expect(yield* Effect.promise(() => Bun.file(path.join(directory, "a.txt")).text())).toBe("before\n")
            expect(yield* Effect.promise(() => Bun.file(path.join(directory, "new.txt")).exists())).toBe(false)
            const reverted = (yield* sessions.get(sessionID)).revert
            const rows = yield* database.db.select().from(SessionMessageTable).all().pipe(Effect.orDie)
            if (action === "normal") {
              yield* sessions.revert.stage({ sessionID, messageID })
              yield* sessions.revert.clear(sessionID)
              expect((yield* sessions.get(sessionID)).revert).toBeUndefined()
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "a.txt")).text())).toBe("after\n")
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "new.txt")).text())).toBe("created\n")
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "z.txt")).text())).toBe("after z\n")
              return
            }
            const target = path.join(directory, action === "clear-create" ? "new.txt" : "z.txt")
            if (action === "stage-delete") yield* Effect.promise(() => fs.unlink(target))
            if (action !== "stage-delete") yield* Effect.promise(() => Bun.write(target, "external edit\n"))
            const failure = yield* (
              action.startsWith("clear")
                ? sessions.revert.clear(sessionID)
                : sessions.revert.stage({ sessionID, messageID })
            ).pipe(Effect.result)
            expect(failure._tag).toBe("Failure")
            if (failure._tag === "Failure") {
              expect(failure.failure).toBeInstanceOf(Snapshot.Error)
              expect(String(failure.failure.message)).toMatch(/changed|overwritten|replaced/)
            }
            expect(yield* Effect.promise(() => Bun.file(path.join(directory, "a.txt")).text())).toBe("before\n")
            expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(action !== "stage-delete")
            if (action !== "stage-delete")
              expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("external edit\n")
            expect((yield* sessions.get(sessionID)).revert).toEqual(reverted)
            expect(yield* database.db.select().from(SessionMessageTable).all().pipe(Effect.orDie)).toEqual(rows)
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
      },
      60_000,
    )
