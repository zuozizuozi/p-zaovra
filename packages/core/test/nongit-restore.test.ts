import { expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { FileMutation } from "@zaovra-ai/core/file-mutation"
import { Global } from "@zaovra-ai/core/global"
import { Location } from "@zaovra-ai/core/location"
import { LocationMutation } from "@zaovra-ai/core/location-mutation"
import { AbsolutePath, RelativePath } from "@zaovra-ai/core/schema"
import { SessionSchema } from "@zaovra-ai/core/session/schema"
import { Snapshot } from "@zaovra-ai/core/snapshot"
import { FileBackup } from "@zaovra-ai/core/file-backup"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_nongit_restore")

function provide(directory: string, filesystem = LayerNode.compile(FSUtil.node)) {
  return Effect.provide(
    AppNodeBuilder.build(LayerNode.group([Snapshot.node, LocationMutation.node, FileMutation.node, FileBackup.node]), [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
      [Global.node, Global.layerWith({ data: path.join(directory, "private-data") })],
      [FSUtil.node, filesystem],
    ]),
  )
}

it.live("non-git writes persist real diffs, undo, redo and preserve external changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const temp = yield* Effect.acquireRelease(Effect.promise(tmpdir), (tmp) =>
        Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.gen(function* () {
        const snapshots = yield* Snapshot.Service
        const mutation = yield* LocationMutation.Service
        const files = yield* FileMutation.Service
        const target = yield* mutation.resolve({ path: "note.txt" })
        yield* Effect.promise(() => Bun.write(target.canonical, "before\n"))
        const before = yield* snapshots.capture({ sessionID })
        expect(before).toBeDefined()
        yield* files.writeTextPreservingBom({ target, content: "after\n", expected: "before\n", sessionID })
        const after = yield* snapshots.capture({ sessionID })
        const diffs = yield* snapshots.diff({ from: before!, to: after! })
        expect(diffs).toHaveLength(1)
        expect(diffs[0].path).toBe(RelativePath.make("note.txt"))
        expect(diffs[0].patch).toContain("-before")
        expect(diffs[0].patch).toContain("+after")
        const selected = new Map([[RelativePath.make("note.txt"), before!]])
        yield* snapshots.restore({ files: selected })
        expect(yield* Effect.promise(() => Bun.file(target.canonical).text())).toBe("before\n")
        yield* snapshots.restore({ files: new Map([[RelativePath.make("note.txt"), after!]]) })
        expect(yield* Effect.promise(() => Bun.file(target.canonical).text())).toBe("after\n")
        yield* Effect.promise(() => Bun.write(target.canonical, "external\n"))
        const conflict = yield* snapshots.restore({ files: selected }).pipe(Effect.result)
        expect(conflict._tag).toBe("Failure")
        expect(yield* Effect.promise(() => Bun.file(target.canonical).text())).toBe("external\n")
      }).pipe(provide(temp.path))
    }),
  ),
)

function workspace<A, E, R>(run: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const temp = yield* Effect.acquireRelease(Effect.promise(tmpdir), (tmp) =>
        Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      return yield* run(temp.path).pipe(provide(temp.path))
    }),
  )
}

it.live("new-file absence and deleted BOM bytes survive undo and redo", () =>
  workspace((directory) =>
    Effect.gen(function* () {
      const snapshots = yield* Snapshot.Service
      const mutation = yield* LocationMutation.Service
      const files = yield* FileMutation.Service
      const added = yield* mutation.resolve({ path: "nested/new.txt" })
      const deleted = yield* mutation.resolve({ path: "old.txt" })
      yield* Effect.promise(() => Bun.write(deleted.canonical, "\uFEFFold\r\n"))
      const before = (yield* snapshots.capture({ sessionID }))!
      yield* files.create({ target: added, content: "new\n", sessionID })
      yield* files.remove({ target: deleted, sessionID })
      const after = (yield* snapshots.capture({ sessionID }))!
      const diff = yield* snapshots.diff({ from: before, to: after })
      expect(diff.map((file) => file.status)).toEqual(["added", "deleted"])
      const paths = [RelativePath.make("nested/new.txt"), RelativePath.make("old.txt")]
      yield* snapshots.restore({ files: new Map(paths.map((file) => [file, before])) })
      expect(yield* Effect.promise(() => Bun.file(added.canonical).exists())).toBe(false)
      expect(Buffer.from(yield* Effect.promise(() => Bun.file(deleted.canonical).arrayBuffer()))).toEqual(
        Buffer.from("\uFEFFold\r\n"),
      )
      yield* snapshots.restore({ files: new Map(paths.map((file) => [file, after])) })
      expect(yield* Effect.promise(() => Bun.file(added.canonical).text())).toBe("new\n")
      expect(yield* Effect.promise(() => Bun.file(deleted.canonical).exists())).toBe(false)
    }),
  ),
)

it.live("all paths are checked before any selected file is restored", () =>
  workspace(() =>
    Effect.gen(function* () {
      const snapshots = yield* Snapshot.Service
      const mutation = yield* LocationMutation.Service
      const files = yield* FileMutation.Service
      const before = (yield* snapshots.capture({ sessionID }))!
      for (const name of ["one.txt", "two.txt"]) {
        const target = yield* mutation.resolve({ path: name })
        yield* files.create({ target, content: "generated", sessionID })
      }
      const target = yield* mutation.resolve({ path: "two.txt" })
      yield* Effect.promise(() => Bun.write(target.canonical, "external"))
      const result = yield* snapshots
        .restore({ files: new Map(["one.txt", "two.txt"].map((file) => [RelativePath.make(file), before])) })
        .pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(yield* Effect.promise(() => Bun.file(path.join(path.dirname(target.canonical), "one.txt")).text())).toBe(
        "generated",
      )
      expect(yield* Effect.promise(() => Bun.file(target.canonical).text())).toBe("external")
    }),
  ),
)

it.live("another Session never lends its history or overwrites a newer Session write", () =>
  workspace(() =>
    Effect.gen(function* () {
      const snapshots = yield* Snapshot.Service
      const mutation = yield* LocationMutation.Service
      const files = yield* FileMutation.Service
      const target = yield* mutation.resolve({ path: "shared.txt" })
      const before = (yield* snapshots.capture({ sessionID }))!
      yield* files.create({ target, content: "first", sessionID })
      const peer = SessionSchema.ID.make("ses_peer")
      const peerBefore = (yield* snapshots.capture({ sessionID: peer }))!
      yield* files.writeTextPreservingBom({ target, content: "peer", expected: "first", sessionID: peer })
      const peerAfter = (yield* snapshots.capture({ sessionID: peer }))!
      expect((yield* snapshots.diff({ from: before, to: peerAfter }).pipe(Effect.result))._tag).toBe("Failure")
      expect(
        (yield* snapshots.restore({ files: new Map([[RelativePath.make("shared.txt"), before]]) }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure")
      expect(yield* Effect.promise(() => Bun.file(target.canonical).text())).toBe("peer")
      yield* snapshots.restore({ files: new Map([[RelativePath.make("shared.txt"), peerBefore]]) })
      expect(yield* Effect.promise(() => Bun.file(target.canonical).text())).toBe("first")
    }),
  ),
)

it.live("oversized changes are explicitly not reversible and cannot be silently restored", () =>
  workspace(() =>
    Effect.gen(function* () {
      const snapshots = yield* Snapshot.Service
      const mutation = yield* LocationMutation.Service
      const files = yield* FileMutation.Service
      const target = yield* mutation.resolve({ path: "large.txt" })
      yield* Effect.promise(() => Bun.write(target.canonical, "before"))
      const before = (yield* snapshots.capture({ sessionID }))!
      const result = yield* files.write({ target, content: new Uint8Array(FileBackup.MAX_FILE_BYTES + 1), sessionID })
      expect(result.backup).toEqual({ reversible: false, reason: "capacity" })
      expect(
        (yield* snapshots.restore({ files: new Map([[RelativePath.make("large.txt"), before]]) }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure")
      expect(Bun.file(target.canonical).size).toBe(FileBackup.MAX_FILE_BYTES + 1)
    }),
  ),
)

it.live("backup persistence failure refuses the write before changing original bytes", () =>
  workspace((directory) =>
    Effect.gen(function* () {
      const mutation = yield* LocationMutation.Service
      const files = yield* FileMutation.Service
      const target = yield* mutation.resolve({ path: "safe.txt" })
      yield* Effect.promise(() => Bun.write(target.canonical, "before"))
      yield* Effect.promise(() =>
        Bun.write(path.join(directory, "private-data/session-file-backup"), "cannot-create-directory"),
      )
      const result = yield* files.write({ target, content: "after", sessionID }).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(yield* Effect.promise(() => Bun.file(target.canonical).text())).toBe("before")
    }),
  ),
)

it.live("failed conditional writes and untracked shell-like writes are not claimed as backed-up changes", () =>
  workspace(() =>
    Effect.gen(function* () {
      const snapshots = yield* Snapshot.Service
      const mutation = yield* LocationMutation.Service
      const files = yield* FileMutation.Service
      const target = yield* mutation.resolve({ path: "external.txt" })
      const before = (yield* snapshots.capture({ sessionID }))!
      yield* Effect.promise(() => Bun.write(target.canonical, "external"))
      expect(
        (yield* files
          .writeTextPreservingBom({ target, content: "wrong", expected: "stale", sessionID })
          .pipe(Effect.result))._tag,
      ).toBe("Failure")
      const after = (yield* snapshots.capture({ sessionID }))!
      expect(yield* snapshots.files({ from: before, to: after })).toEqual([])
      expect(yield* snapshots.capture()).toBeUndefined()
      expect(yield* Effect.promise(() => Bun.file(target.canonical).text())).toBe("external")
    }),
  ),
)

it.live("replacement backups and expected written hashes preserve exact BOM bytes", () =>
  workspace(() =>
    Effect.gen(function* () {
      const snapshots = yield* Snapshot.Service
      const mutation = yield* LocationMutation.Service
      const files = yield* FileMutation.Service
      const target = yield* mutation.resolve({ path: "bom.txt" })
      yield* Effect.promise(() => Bun.write(target.canonical, "\uFEFFbefore\r\n"))
      const before = (yield* snapshots.capture({ sessionID }))!
      yield* files.writeTextPreservingBom({ target, content: "after\r\n", expected: "before\r\n", sessionID })
      yield* snapshots.restore({ files: new Map([[RelativePath.make("bom.txt"), before]]) })
      expect(Buffer.from(yield* Effect.promise(() => Bun.file(target.canonical).arrayBuffer()))).toEqual(
        Buffer.from("\uFEFFbefore\r\n"),
      )
    }),
  ),
)

it.live("write-ahead index and original blob survive an interrupted unverified write", () =>
  workspace((directory) =>
    Effect.gen(function* () {
      const snapshots = yield* Snapshot.Service
      const backups = yield* FileBackup.Service
      const mutation = yield* LocationMutation.Service
      const target = yield* mutation.resolve({ path: "interrupted.txt" })
      yield* Effect.promise(() => Bun.write(target.canonical, "before"))
      const point = (yield* snapshots.capture({ sessionID }))!
      const ticket = (yield* backups.begin({ sessionID, target, before: new TextEncoder().encode("before") }))!
      const privateFolder = FileBackup.directory(path.join(directory, "private-data"), sessionID)
      const placements = yield* Effect.promise(() => fs.readdir(privateFolder))
      const journal = yield* Effect.promise(() =>
        Bun.file(path.join(privateFolder, placements[0], "journal.json")).json(),
      )
      expect(journal.pending[0]).toMatchObject({ target: target.canonical, before: { hash: ticket.before.hash } })
      expect(
        yield* Effect.promise(() => Bun.file(path.join(privateFolder, placements[0], ticket.before.hash!)).text()),
      ).toBe("before")
      yield* Effect.promise(() => Bun.write(target.canonical, "interrupted unknown bytes"))
      expect(yield* snapshots.capture({ sessionID })).toBeUndefined()
      expect(
        (yield* snapshots
          .restore({ files: new Map([[RelativePath.make("interrupted.txt"), point]]) })
          .pipe(Effect.result))._tag,
      ).toBe("Failure")
      expect(yield* Effect.promise(() => Bun.file(target.canonical).text())).toBe("interrupted unknown bytes")
    }),
  ),
)

it.live("an ancestor redirected outside the active folder is rejected before undo", () =>
  workspace((directory) =>
    Effect.gen(function* () {
      const snapshots = yield* Snapshot.Service
      const mutation = yield* LocationMutation.Service
      const files = yield* FileMutation.Service
      const target = yield* mutation.resolve({ path: "sub/note.txt" })
      const before = (yield* snapshots.capture({ sessionID }))!
      yield* files.create({ target, content: "ours", sessionID })
      const external = path.join(directory, "external")
      yield* Effect.promise(() => Bun.write(path.join(external, "note.txt"), "external"))
      yield* Effect.promise(() => fs.rename(path.join(directory, "sub"), path.join(directory, "original-sub")))
      yield* Effect.promise(() =>
        fs.symlink(external, path.join(directory, "sub"), process.platform === "win32" ? "junction" : "dir"),
      )
      expect(
        (yield* snapshots
          .restore({ files: new Map([[RelativePath.make("sub/note.txt"), before]]) })
          .pipe(Effect.result))._tag,
      ).toBe("Failure")
      expect(yield* Effect.promise(() => Bun.file(path.join(external, "note.txt")).text())).toBe("external")
      expect(yield* Effect.promise(() => Bun.file(path.join(directory, "original-sub/note.txt")).text())).toBe("ours")
    }),
  ),
)

it.live("a file changed back to original bytes does not invent a net turn diff", () =>
  workspace(() =>
    Effect.gen(function* () {
      const snapshots = yield* Snapshot.Service
      const mutation = yield* LocationMutation.Service
      const files = yield* FileMutation.Service
      const target = yield* mutation.resolve({ path: "roundtrip.txt" })
      yield* Effect.promise(() => Bun.write(target.canonical, "original"))
      const before = (yield* snapshots.capture({ sessionID }))!
      yield* files.write({ target, content: "intermediate", sessionID })
      yield* files.write({ target, content: "original", sessionID })
      const after = (yield* snapshots.capture({ sessionID }))!
      expect(yield* snapshots.files({ from: before, to: after })).toEqual([])
      expect(yield* snapshots.diff({ from: before, to: after })).toEqual([])
    }),
  ),
)

it.live("post-write external changes during backup finalization never become the expected write hash", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const temp = yield* Effect.acquireRelease(Effect.promise(tmpdir), (tmp) =>
        Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const target = path.join(temp.path, "raced.txt")
      const filesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...fs,
            rename: (from, file) =>
              fs.rename(from, file).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    if (path.basename(file) === FileBackup.hash(new TextEncoder().encode("ours")))
                      yield* Effect.promise(() => Bun.write(target, "external"))
                  }),
                ),
              ),
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      yield* Effect.gen(function* () {
        const snapshots = yield* Snapshot.Service
        const mutation = yield* LocationMutation.Service
        const files = yield* FileMutation.Service
        const before = (yield* snapshots.capture({ sessionID }))!
        yield* files.create({ target: yield* mutation.resolve({ path: "raced.txt" }), content: "ours", sessionID })
        expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("external")
        expect(
          (yield* snapshots.restore({ files: new Map([[RelativePath.make("raced.txt"), before]]) }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure")
        expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("external")
      }).pipe(provide(temp.path, filesystem))
    }),
  ),
)

it.live("undo never deletes external bytes written while its backup journal is persisted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const temp = yield* Effect.acquireRelease(Effect.promise(tmpdir), (tmp) =>
        Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const target = path.join(temp.path, "new.txt")
      let armed = false
      const filesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...fs,
            rename: (from, file) =>
              fs.rename(from, file).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    if (armed && path.basename(file) === "journal.json") {
                      armed = false
                      yield* Effect.promise(() => Bun.write(target, "external"))
                    }
                  }),
                ),
              ),
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      yield* Effect.gen(function* () {
        const snapshots = yield* Snapshot.Service
        const mutation = yield* LocationMutation.Service
        const files = yield* FileMutation.Service
        const before = (yield* snapshots.capture({ sessionID }))!
        yield* files.create({ target: yield* mutation.resolve({ path: "new.txt" }), content: "ours", sessionID })
        armed = true
        const result = yield* snapshots
          .restore({ files: new Map([[RelativePath.make("new.txt"), before]]) })
          .pipe(Effect.result)
        expect(result._tag).toBe("Failure")
        expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("external")
      }).pipe(provide(temp.path, filesystem))
    }),
  ),
)

it.live("saving a backup cannot make replacement or deletion overwrite a late external edit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const temp = yield* Effect.acquireRelease(Effect.promise(tmpdir), (tmp) =>
        Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      let armed: string | undefined
      const filesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...fs,
            rename: (from, file) =>
              fs.rename(from, file).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    if (armed && path.basename(file) === "journal.json") {
                      const target = armed
                      armed = undefined
                      yield* Effect.promise(() => Bun.write(target, "external"))
                    }
                  }),
                ),
              ),
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      yield* Effect.gen(function* () {
        const mutation = yield* LocationMutation.Service
        const files = yield* FileMutation.Service
        for (const operation of ["replace", "delete"]) {
          const target = yield* mutation.resolve({ path: `${operation}.txt` })
          yield* Effect.promise(() => Bun.write(target.canonical, "before"))
          armed = target.canonical
          const result =
            operation === "replace"
              ? yield* files
                  .writeTextPreservingBom({ target, content: "ours", expected: "before", sessionID })
                  .pipe(Effect.result)
              : yield* files.remove({ target, sessionID }).pipe(Effect.result)
          expect(result._tag).toBe("Failure")
          expect(yield* Effect.promise(() => Bun.file(target.canonical).text())).toBe("external")
        }
      }).pipe(provide(temp.path, filesystem))
    }),
  ),
)
