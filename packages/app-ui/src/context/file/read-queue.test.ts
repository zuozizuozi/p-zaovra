import { expect, test } from "bun:test"
import { createFileReadQueue } from "./read-queue"
import { invalidateFromWatcher } from "./watcher"

test("invalidation coalesces a trailing read and rejects the old snapshot", async () => {
  const queue = createFileReadQueue()
  const old = Promise.withResolvers<string>()
  const next = Promise.withResolvers<string>()
  const reads = [old.promise, next.promise]
  const values: string[] = []
  let count = 0
  const read = () => reads[count++]!
  const loaded = (value: string) => { values.push(value) }
  const failed = () => { throw new Error("unexpected failure") }
  const pending = queue.run("project/file", false, read, loaded, failed)
  for (let i = 0; i < 5; i++) void queue.run("project/file", true, read, loaded, failed)
  old.resolve("before")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(values).toEqual([])
  expect(count).toBe(2)
  next.resolve("after")
  await pending
  expect(values).toEqual(["after"])
})

test("scope reset suppresses old responses even when the key is reused", async () => {
  const queue = createFileReadQueue()
  const old = Promise.withResolvers<string>()
  const values: string[] = []
  const pending = queue.run("file", false, () => old.promise, (x) => { values.push(x) }, () => {})
  queue.clear()
  await queue.run("file", false, async () => "new", (x) => { values.push(x) }, () => {})
  old.resolve("old")
  await pending
  expect(values).toEqual(["new"])
})

test("watcher unlink invalidates a pending success; failed trailing read can retry", async () => {
  const queue = createFileReadQueue()
  const old = Promise.withResolvers<string>()
  const values: string[] = []
  const errors: unknown[] = []
  let reads = 0
  const read = () => {
    reads++
    if (reads === 1) return old.promise
    if (reads === 2) return Promise.reject(new Error("File missing"))
    return Promise.resolve("recreated")
  }
  const load = (force: boolean) => queue.run("file", force, read, (value) => { values.push(value) }, (error) => { errors.push(error) })
  const pending = load(false)
  invalidateFromWatcher({ type: "file.watcher.updated", properties: { file: "file", event: "unlink" } }, {
    normalize: (path) => path,
    hasFile: () => true,
    loadFile: () => { void load(true) },
    node: () => undefined,
    isDirLoaded: () => false,
    refreshDir: () => {},
  })
  old.resolve("deleted content")
  await pending
  expect(values).toEqual([])
  expect(errors).toHaveLength(1)
  await load(false)
  expect(values).toEqual(["recreated"])
  expect(reads).toBe(3)
})

test("old finally cannot remove a pending replacement after reset", async () => {
  const queue = createFileReadQueue()
  const old = Promise.withResolvers<string>()
  const next = Promise.withResolvers<string>()
  const values: string[] = []
  const first = queue.run("file", false, () => old.promise, (x) => { values.push(x) }, () => {})
  queue.clear()
  const second = queue.run("file", false, () => next.promise, (x) => { values.push(x) }, () => {})
  old.resolve("stale")
  await first
  const joined = queue.run("file", false, async () => "unexpected duplicate", (x) => { values.push(x) }, () => {})
  expect(joined).toBe(second)
  next.resolve("current")
  await joined
  expect(values).toEqual(["current"])
})
