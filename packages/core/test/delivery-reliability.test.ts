import { expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { systemError } from "effect/PlatformError"
import path from "node:path"
import { DeliveryAudit } from "../src/session/delivery-audit"
import { DeliveryContract } from "../src/session/delivery-contract"
import { SessionOutcome } from "../src/session/outcome"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import { FSUtil } from "../src/fs-util"
import { LayerNode } from "../src/effect/layer-node"
import { tmpdir } from "./fixture/tmpdir"

const user = (text: string, id: string): SessionMessage.User => ({
  type: "user",
  id: SessionMessage.ID.make(id),
  text,
  time: { created: DateTime.makeUnsafe(1) },
})
const live = LayerNode.compile(FSUtil.node)
const inspect = (directory: string, text: string) =>
  Effect.runPromise(
    FSUtil.Service.use((fs) =>
      DeliveryAudit.inspect(fs, directory, SessionOutcome.requested([user(text, "msg_source")]).entries),
    ).pipe(Effect.provide(live)),
  )

test("367 additions, exact corrections and withdrawals keep original ranges and message versions", () => {
  const first = user("交付 old.json。\n全部数值以秒为单位。", "msg_one")
  const changed = user("修改要求：将要求“交付 old.json。”改为“交付 new.json。”", "msg_two")
  const removed = user("修改要求：取消要求“全部数值以秒为单位。”", "msg_three")
  const entries = SessionOutcome.requested([first, changed, removed]).entries
  expect(entries.map((entry) => entry.text)).toEqual(["交付 old.json。", "全部数值以秒为单位。", "交付 new.json。"])
  expect(entries.slice(0, 2).map((entry) => entry.withdrawnBy)).toEqual([changed.id, removed.id])
  expect(DeliveryAudit.expected(entries).map((item) => item.path)).toEqual(["new.json"])
  for (const entry of entries) {
    const source = [first, changed, removed].find((message) => message.id === entry.sourceMessageID)!
    expect(source.text.slice(entry.sourceStart, entry.sourceEnd)).toBe(entry.text)
    expect(entry.version).toHaveLength(64)
  }
})

test("367 contradictory and ambiguous clauses are preserved; examples and references add no obligations", () => {
  const request = SessionOutcome.requested([
    user("交付 `a.json`，顶层为数组。", "msg_first"),
    user("追加要求：`a.json` 顶层为对象。", "msg_conflict"),
    user("追加要求：参考图片中的说明不是新需求；例如创建 example.json", "msg_reference"),
  ])
  expect(request.entries.filter((entry) => !entry.withdrawnBy)).toHaveLength(4)
  expect(DeliveryAudit.expected(request.entries).map((entry) => entry.shape)).toEqual(["数组", "对象"])
  expect(DeliveryAudit.expected([{ id: 1, text: "例如创建 example.json" }])).toEqual([])
  const quoted = SessionOutcome.requested([
    user("参考文本：\n```text\nCreate example.json.\n```\n交付 real.json。", "msg_data"),
  ])
  expect(DeliveryAudit.expected(quoted.entries).map((entry) => entry.path)).toEqual(["real.json"])
})

test("367 deterministic checks enforce JSON syntax/type and reobserve changed files", async () => {
  await using dir = await tmpdir()
  const request = "交付 `result.json`，顶层为数组。"
  await Bun.write(path.join(dir.path, "result.json"), "{}")
  expect((await inspect(dir.path, request))[0].problem).toContain("type")
  await Bun.write(path.join(dir.path, "result.json"), "[]")
  const passed = (await inspect(dir.path, request))[0]
  expect(passed.problem).toBeUndefined()
  await Bun.write(path.join(dir.path, "result.json"), "[1]")
  expect((await inspect(dir.path, request))[0].digest).not.toBe(passed.digest)
  await Bun.write(path.join(dir.path, "result.json"), "{")
  expect((await inspect(dir.path, request))[0].problem).toBe("invalid JSON")
})

test("367 deterministic file-count and byte budgets return explicit unverified", async () => {
  await using dir = await tmpdir()
  await Bun.write(path.join(dir.path, "a.txt"), "ok")
  const results = await inspect(dir.path, Array.from({ length: 33 }, () => "交付 a.txt。").join("\n"))
  expect(results.filter((item) => item.digest)).toHaveLength(32)
  expect(results[32].problem).toContain("budget exhausted")
  await Bun.write(path.join(dir.path, "large.txt"), new Uint8Array(DeliveryAudit.budget.bytes + 1))
  expect((await inspect(dir.path, "交付 large.txt。"))[0].problem).toContain("budget")
  const files = ["first.txt", "second.txt", "third.txt"].map((file) => path.join(dir.path, file))
  for (const file of files) await Bun.write(file, "ab")
  const fingerprints = await Effect.runPromise(
    FSUtil.Service.use((fs) => SessionOutcome.fingerprint(fs, files, { files: 2, bytes: 2 })).pipe(
      Effect.provide(live),
    ),
  )
  expect(fingerprints.map((item) => Boolean(item.digest))).toEqual([true, false, false])
})

test("367 a denied read remains unverified and never attempts an external action", async () => {
  await using dir = await tmpdir()
  await Bun.write(path.join(dir.path, "a.txt"), "ok")
  const result = await Effect.runPromise(
    FSUtil.Service.use((fs) =>
      DeliveryAudit.inspect(
        {
          ...fs,
          readFile: () =>
            Effect.fail(systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "readFile" })),
        },
        dir.path,
        [{ id: 1, text: "交付 a.txt。" }],
      ),
    ).pipe(Effect.provide(live)),
  )
  expect(result[0].digest).toBe("")
  expect(result[0].problem).toContain("unreadable")
})

test("367 host file inspection has one total wall budget across stalled reads", async () => {
  await using dir = await tmpdir()
  await Bun.write(path.join(dir.path, "a.txt"), "ok")
  const calls = { reads: 0 }
  const results = await Effect.runPromise(
    FSUtil.Service.use((fs) =>
      DeliveryAudit.inspect(
        {
          ...fs,
          readFile: () => {
            calls.reads++
            return Effect.never
          },
        },
        dir.path,
        [
          { id: 1, text: "交付 a.txt。" },
          { id: 2, text: "交付 a.txt。" },
        ],
      ),
    ).pipe(Effect.provide(live)),
  )
  expect(calls.reads).toBe(1)
  expect(results.every((item) => !item.digest && item.problem?.includes("wall-clock"))).toBe(true)
})

test("368 cached replay uses configured rates; unknown prices grant no inferred budget; receipts survive restore", () => {
  const prices = [{ input: 1, output: 2, cache: { read: 0.1, write: 1 } }]
  expect(DeliveryContract.allowance(0, prices, 0, "").output).toBe(0)
  expect(DeliveryContract.allowance(1, [], 0, "").output).toBe(0)
  expect(DeliveryContract.allowance(0.01, prices, 0, "x".repeat(240_000)).output).toBe(0)
  expect(DeliveryContract.allowance(0.01, prices, 60_000, "x".repeat(240_000)).output).toBe(1_024)
  const marker: SessionMessage.Synthetic = {
    type: "synthetic",
    id: SessionMessage.ID.make("msg_receipt"),
    sessionID: SessionSchema.ID.make("ses_delivery"),
    time: { created: DateTime.makeUnsafe(1) },
    text:
      DeliveryContract.prefix +
      JSON.stringify({
        request: "msg_user",
        started: 1,
        tokens: 1024,
        decision: "review",
        missing: ["permission denied"],
      }),
  }
  const restored = Schema.decodeUnknownSync(SessionMessage.Message)(
    JSON.parse(JSON.stringify(Schema.encodeSync(SessionMessage.Message)(marker))),
  )
  expect(DeliveryContract.receipt([restored], "msg_user")?.missing).toEqual(["permission denied"])
  expect(DeliveryContract.receipt([restored], "msg_other")).toBeUndefined()
})

test("368 hard gaps distinguish failed artifacts and missing real execution from unknown coverage", () => {
  const entries = SessionOutcome.requested([user("实际运行服务。\n解释设计取舍。", "msg_run")]).entries
  expect(DeliveryContract.gaps(entries, [], [])).toEqual([
    "requirement 1: actual execution evidence missing: 实际运行服务。",
  ])
  expect(
    DeliveryContract.gaps(
      entries,
      [],
      [{ kind: "test", callID: "import-only", command: "import service", exit: 0, requirements: ["实际运行服务。"] }],
    ),
  ).toHaveLength(1)
  expect(
    DeliveryContract.gaps(
      entries,
      [],
      [{ kind: "smoke", callID: "real-run", command: "run service", exit: 0, requirements: ["实际运行服务。"] }],
    ),
  ).toEqual([])
  expect(
    DeliveryContract.gaps(
      [],
      [{ requirement: 1, path: "large.json", digest: "", problem: "unverified: byte budget exhausted" }],
      [],
    ),
  ).toEqual([])
  expect(
    DeliveryContract.gaps([], [{ requirement: 1, path: "result.json", digest: "", problem: "invalid JSON" }], []),
  ).toHaveLength(1)
})
