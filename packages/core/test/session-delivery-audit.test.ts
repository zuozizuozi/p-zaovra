import { expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import path from "node:path"
import { symlink, unlink } from "node:fs/promises"
import { DeliveryAudit } from "../src/session/delivery-audit"
import { FSUtil } from "../src/fs-util"
import { LayerNode } from "../src/effect/layer-node"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { tmpdir } from "./fixture/tmpdir"
import { SessionOutcome } from "../src/session/outcome"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"

const entries = (text: string) => [{ id: 1, text }]
const live = LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem]))
const inspect = (directory: string, text: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return yield* DeliveryAudit.inspect(fs, directory, entries(text))
    }).pipe(Effect.provide(live)),
  )

test("document-only edits preserve code evidence but invalidate document checks and real dependency changes", async () => {
  await using dir = await tmpdir()
  const files = ["source.js", "source.test.js", "package.json", "README.md"].map((file) => path.join(dir.path, file))
  for (const file of files) await Bun.write(file, "initial")
  const capture = () =>
    Effect.runPromise(FSUtil.Service.use((fs) => SessionOutcome.fingerprint(fs, files)).pipe(Effect.provide(live)))
  const before = await capture()
  const code = { kind: "test" as const, command: "npm test", callID: "code", exit: 0, targets: before.slice(0, 3) }
  const docs = { kind: "test" as const, command: "node docs-test.js", callID: "docs", exit: 0, targets: before }
  await Bun.write(files[3], "updated documentation")
  expect(SessionOutcome.checkFreshness(code, await capture()).fresh).toBe(true)
  expect(SessionOutcome.checkFreshness(docs, await capture())).toMatchObject({
    fresh: false,
    changedTargets: [files[3]],
  })
  for (const file of files.slice(0, 3)) {
    await Bun.write(file, "changed dependency")
    expect(SessionOutcome.checkFreshness(code, await capture())).toMatchObject({ fresh: false, changedTargets: [file] })
    await Bun.write(file, "initial")
  }
  await unlink(files[0])
  expect(SessionOutcome.checkFreshness(code, await capture()).fresh).toBe(false)
  const legacy = { kind: "test" as const, command: "npm test", callID: "legacy", exit: 0, snapshot: "before" }
  expect(SessionOutcome.checkFreshness(legacy, [], "before").fresh).toBe(true)
  expect(SessionOutcome.checkFreshness(legacy, [], "after").fresh).toBe(false)
  expect(SessionOutcome.checkFreshness(legacy, []).fresh).toBe(false)
})

test("only explicit unconditional file deliverables become host obligations", () => {
  for (const text of [
    "交付 README.md。",
    "Create `dist/app.js`.",
    "创建空文件 .gitkeep",
    "提供 README",
    "最终提供 README，说明：",
  ])
    expect(DeliveryAudit.expected(entries(text))).toHaveLength(1)
  for (const text of [
    "读取 README.md",
    "删除 legacy.js",
    "不要生成 README.md",
    "Read `README.md`.",
    "Create README.md if needed",
    "例如创建 README.md",
    "提供报告",
    "解释 create README.md 的含义",
  ])
    expect(DeliveryAudit.expected(entries(text))).toEqual([])
  expect(DeliveryAudit.expected([{ id: 1, text: "交付 README.md。", withdrawnBy: "msg_cancel" }])).toEqual([])
})

test("the historical PK README clause survives continuation and retains its host obligation", () => {
  const time = { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) }
  const request = SessionOutcome.requested([
    {
      type: "user",
      id: SessionMessage.ID.make("msg_pk"),
      time,
      text: "最终提供 README，说明：\n\n- 启动方法\n- 操作方式\n- 实际完成的验证",
    },
    { type: "user", id: SessionMessage.ID.make("msg_more"), time, text: "继续，再增加暂停按钮。" },
  ])
  expect(DeliveryAudit.expected(request.entries)).toEqual([{ requirement: 1, path: "README", nonempty: true }])
})

test("a generic README request accepts an existing README.txt without inventing a markdown requirement", async () => {
  await using dir = await tmpdir()
  await Bun.write(path.join(dir.path, "README.txt"), "Open index.html")
  expect((await inspect(dir.path, "最终提供 README，说明："))[0].problem).toBeUndefined()
})

test("missing and empty README are gaps; repaired files have fresh host fingerprints", async () => {
  await using dir = await tmpdir()
  expect((await inspect(dir.path, "交付 README.md。"))[0].problem).toContain("missing")
  await Bun.write(path.join(dir.path, "README.md"), " \n")
  expect((await inspect(dir.path, "交付 README.md。"))[0].problem).toContain("empty")
  await Bun.write(path.join(dir.path, "README.md"), "# Run\nOpen index.html")
  const first = (await inspect(dir.path, "交付 README.md。"))[0]
  expect(first.problem).toBeUndefined()
  expect(first.digest).toHaveLength(64)
  await Bun.write(path.join(dir.path, "README.md"), "# Updated")
  expect((await inspect(dir.path, "交付 README.md。"))[0].digest).not.toBe(first.digest)
  await unlink(path.join(dir.path, "README.md"))
  expect((await inspect(dir.path, "交付 README.md。"))[0].digest).toBe("")
})

test("explicit empty files and nested files are valid deliverables", async () => {
  await using dir = await tmpdir()
  await Bun.write(path.join(dir.path, ".gitkeep"), "")
  await Bun.write(path.join(dir.path, "dist/app.js"), "export const ok = true")
  expect((await inspect(dir.path, "创建空文件 .gitkeep"))[0].problem).toBeUndefined()
  expect((await inspect(dir.path, "Create `dist/app.js`."))[0].problem).toBeUndefined()
})

test("parent paths, absolute paths and directory junction escapes are not read", async () => {
  await using dir = await tmpdir()
  await using outside = await tmpdir()
  await Bun.write(path.join(outside.path, "secret.txt"), "outside")
  for (const file of ["../secret.txt", "C:/secret.txt", "/secret.txt"])
    expect((await inspect(dir.path, `交付 \`${file}\``))[0].problem).toContain("outside")
  await symlink(outside.path, path.join(dir.path, "link"), process.platform === "win32" ? "junction" : "dir")
  expect((await inspect(dir.path, "交付 `link/secret.txt`"))[0].problem).toContain("outside")
  await unlink(path.join(dir.path, "link"))
})

test("host outcome rejects missing or stale artifacts and accepts repair without rerunning unaffected checks", async () => {
  await using dir = await tmpdir()
  const time = { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) }
  const user: SessionMessage.User = {
    type: "user",
    id: SessionMessage.ID.make("msg_request"),
    time,
    text: "交付 README.md。",
  }
  const targets = [{ path: path.join(dir.path, "source.js"), digest: "unchanged-verified-source" }]
  const messages = (recorded: readonly DeliveryAudit.Observation[]): SessionMessage.Message[] => [
    user,
    {
      type: "synthetic",
      id: SessionMessage.ID.make("msg_closing"),
      sessionID: SessionSchema.ID.make("ses_delivery"),
      text: "Verification closing review: {}",
      time,
    },
    {
      type: "assistant",
      id: SessionMessage.ID.make("msg_answer"),
      time,
      finish: "stop",
      agent: "build",
      model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
      content: [
        {
          type: "tool",
          id: "green",
          name: "bash",
          time,
          state: {
            status: "completed",
            input: {},
            content: [],
            structured: {
              verification: {
                kind: "test",
                command: "node test.js",
                callID: "green",
                exit: 0,
                targets,
                requirements: ["source behavior"],
              },
            },
          },
        },
        {
          type: "tool",
          id: "review",
          name: "verification_review",
          time,
          state: {
            status: "completed",
            input: {},
            content: [],
            structured: {
              artifacts: recorded,
              review: {
                userMessageID: user.id,
                items: [{ requirement: 1, evidence: ["green"], status: "verified", note: "delivered" }],
                unverified: [],
              },
            },
          },
        },
      ],
    },
  ]
  const outcome = (recorded: readonly DeliveryAudit.Observation[], current: readonly DeliveryAudit.Observation[]) =>
    SessionOutcome.derive(messages(recorded), false, undefined, targets, [], undefined, dir.path, current)
  const missing = await inspect(dir.path, user.text)
  expect(outcome(missing, missing).state).toBe("completed_unverified")
  expect(outcome(missing, missing).missing.join(" ")).toContain("README")
  await Bun.write(path.join(dir.path, "README.md"), "# Usage\nOpen index.html")
  const repaired = await inspect(dir.path, user.text)
  expect(outcome(missing, repaired).state).toBe("completed_unverified")
  expect(outcome(repaired, repaired).state).toBe("completed_verified")
  await Bun.write(path.join(dir.path, "README.md"), "# Changed after review")
  const changed = await inspect(dir.path, user.text)
  expect(outcome(repaired, changed).state).toBe("completed_unverified")
  expect(outcome(changed, changed).state).toBe("completed_verified")
  expect(outcome(changed, changed).checks).toHaveLength(1)
  await unlink(path.join(dir.path, "README.md"))
  expect(outcome(changed, await inspect(dir.path, user.text)).state).toBe("completed_unverified")
  // Fault injection after successful review: a model completion claim cannot
  // hide the deletion, and restoring bytes needs a new host observation only.
  await Bun.write(path.join(dir.path, "README.md"), "# Repaired after deletion")
  const restored = await inspect(dir.path, user.text)
  expect(outcome(changed, restored).missing.join(" ")).toContain("changed or not captured")
  expect(outcome(restored, restored).state).toBe("completed_verified")
  expect(outcome(restored, restored).checks.map((check) => check.callID)).toEqual(["green"])
  // Legacy reviews without host artifact observations cannot certify them.
  expect(outcome([], repaired).state).toBe("completed_unverified")
  const unrequested = messages([]).map((message) =>
    message.type === "user" ? { ...message, text: "实现排序功能。" } : message,
  )
  expect(SessionOutcome.derive(unrequested, false, undefined, targets, [], undefined, dir.path, []).state).toBe(
    "completed_verified",
  )
})
