import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { MemoryContext } from "@zaovra-ai/core/memory/context"
import { MemoryRecorder } from "@zaovra-ai/core/memory/recorder"
import { MemoryStore } from "@zaovra-ai/core/memory/store"
import { Memory } from "@zaovra-ai/schema/memory"
import { Project } from "@zaovra-ai/core/project"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionMessageTable, SessionTable } from "@zaovra-ai/core/session/sql"
import { DateTime } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, MemoryStore.node, MemoryRecorder.node])),
)

const place = { project: Project.ID.global, directory: "/project" }
const project = MemoryStore.scope(place)
const user = Memory.Scope.user
const first = SessionV2.ID.make("ses_memory_first")
const second = SessionV2.ID.make("ses_memory_second")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values(
      [first, second].map((id, index) => ({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: index === 0 ? "修登录超时" : "加导出按钮",
        version: "test",
        agent: "test",
      })),
    )
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const say = (session: SessionV2.ID, seq: number, type: "user" | "assistant", text: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: SessionMessage.ID.make(`msg_${session}_${seq}`),
        session_id: session,
        type,
        seq,
        time_created: 1_700_000_000_000 + seq,
        data: (type === "user"
          ? { text, time: { created: 1 } }
          : {
              content: [
                {
                  type: "tool",
                  id: "call",
                  name: "bash",
                  state: { status: "completed", input: { command: "隐藏的工具输入 redis" } },
                },
                { type: "text", id: "text", text },
              ],
              time: { created: 1 },
            }) as never,
      })
      .run()
      .pipe(Effect.orDie)
  })

const check = {
  scope: project,
  kind: "practice" as const,
  key: "check:test::bun test",
  text: "test: `bun test`",
  verification: "exit 0",
}

describe("memory store", () => {
  test("a repository is one scope; folders that are not repositories do not share notes", () => {
    const repository = Project.ID.make("prj_repo")
    expect(MemoryStore.scope({ project: repository, directory: "/a" })).toBe(
      MemoryStore.scope({ project: repository, directory: "/a/b" }),
    )
    const left = MemoryStore.scope({ project: Project.ID.global, directory: "C:\\Users\\me\\报表" })
    expect(left).toBe(MemoryStore.scope({ project: Project.ID.global, directory: "c:/users/me/报表" }))
    expect(left).not.toBe(MemoryStore.scope({ project: Project.ID.global, directory: "C:/Users/me/合同" }))
    expect(left).not.toBe(Memory.Scope.user)
  })

  it.live("a passed check becomes a practice only once a second conversation sees it too", () =>
    Effect.gen(function* () {
      yield* setup
      const store = yield* MemoryStore.Service
      expect((yield* store.observe({ ...check, sessionID: first }))?.status).toBe("unverified")
      expect((yield* store.observe({ ...check, sessionID: first }))?.status).toBe("unverified")
      const seen = yield* store.observe({ ...check, sessionID: second })
      expect(seen?.status).toBe("verified")
      expect(seen?.hits).toBe(3)
      expect(yield* store.list(project)).toHaveLength(1)
    }),
  )

  it.live("nothing is recorded for a scope that is turned off, and what was kept stays", () =>
    Effect.gen(function* () {
      yield* setup
      const store = yield* MemoryStore.Service
      const kept = yield* store.observe({ ...check, key: "check:test::before-off", sessionID: first })
      yield* store.silence(project, true)
      expect(yield* store.observe({ ...check, key: "check:test::while-off", sessionID: first })).toBeUndefined()
      expect((yield* store.list(project)).map((note) => note.id)).toContain(kept!.id)
      yield* store.silence(project, false)
      expect(yield* store.observe({ ...check, key: "check:test::while-off", sessionID: first })).toBeDefined()
    }),
  )

  it.live("a deleted note stays deleted, keeps no text, and is not recorded again", () =>
    Effect.gen(function* () {
      yield* setup
      const store = yield* MemoryStore.Service
      const note = yield* store.observe({ ...check, key: "check:test::deleted", sessionID: first })
      yield* store.remove(note!.id)
      expect(yield* store.get(note!.id)).toBeUndefined()
      expect(yield* store.observe({ ...check, key: "check:test::deleted", sessionID: second })).toBeUndefined()
      expect((yield* store.list(project)).some((item) => item.id === note!.id)).toBe(false)
      const { db } = yield* Database.Service
      const rows = yield* db
        .all<{ text: string }>(`select text from memory_note where id = '${note!.id}'`)
        .pipe(Effect.orDie)
      expect(rows).toEqual([{ text: "" }])
    }),
  )

  it.live("the user's edit is kept when the host sees the fact again; clearing empties one scope only", () =>
    Effect.gen(function* () {
      yield* setup
      const store = yield* MemoryStore.Service
      const note = yield* store.observe({ ...check, key: "check:test::edited", sessionID: first })
      const edited = yield* store.edit(note!.id, { text: "测试用 bun test，先装依赖" })
      expect(edited).toMatchObject({ origin: "user", status: "verified", text: "测试用 bun test，先装依赖" })
      const again = yield* store.observe({ ...check, key: "check:test::edited", sessionID: second })
      expect(again?.text).toBe("测试用 bun test，先装依赖")
      const kept = yield* store.write({
        scope: user,
        kind: "preference",
        text: "用中文回答",
        origin: "user",
        status: "verified",
      })
      expect(
        yield* store.write({
          scope: user,
          kind: "preference",
          text: " 用中文回答 ",
          origin: "user",
          status: "verified",
        }),
      ).toEqual(kept)
      yield* store.clear(project)
      expect(yield* store.list(project)).toEqual([])
      expect(yield* store.list(user)).toHaveLength(1)
      yield* store.clear(user)
    }),
  )

  it.live("search finds what was said in other conversations, not tool input and not the asking conversation", () =>
    Effect.gen(function* () {
      yield* setup
      const store = yield* MemoryStore.Service
      yield* say(first, 1, "user", "登录接口超时，帮我看看")
      yield* say(first, 2, "assistant", "原因找到了：连接池上限是 5，高峰期排队导致超时。已把上限调到 20。")
      yield* say(second, 1, "user", "上次登录超时最后怎么解决的？")
      const found = yield* store.search({ scope: project, place, query: "超时 连接池", exclude: second })
      expect(found.sessions).toHaveLength(1)
      expect(found.sessions[0]).toMatchObject({ sessionID: first, title: "修登录超时" })
      expect(found.sessions[0].passages[0].text).toContain("连接池上限是 5")
      expect((yield* store.search({ scope: project, place, query: "redis" })).sessions).toEqual([])
      expect(
        (yield* store.search({ scope: project, place, query: "登录", exclude: first })).sessions.map(
          (item) => item.sessionID,
        ),
      ).toEqual([second])
      expect((yield* store.search({ scope: project, place, query: "100%_" })).sessions).toEqual([])
    }),
  )
})

describe("memory recorder", () => {
  test("recognises checks worth repeating and ignores everything else", () => {
    expect(MemoryRecorder.practice({ command: "bun test", root: "/project", cwd: "/project/packages/core" })).toEqual({
      kind: "practice",
      key: "check:test:packages/core:bun test",
      text: "test: `bun test` in packages/core",
      verification: "exit 0",
    })
    expect(MemoryRecorder.practice({ command: "make all", declared: "build", root: "/project" })?.key).toBe(
      "check:build::make all",
    )
    expect(MemoryRecorder.practice({ command: "ls -la", root: "/project" })).toBeUndefined()
    expect(MemoryRecorder.practice({ command: "node -e 1", declared: "smoke", root: "/project" })).toBeUndefined()
    expect(MemoryRecorder.practice({ command: "bun test\nrm -rf x", root: "/project" })).toBeUndefined()
    expect(MemoryRecorder.practice({ command: `bun test ${"x".repeat(200)}`, root: "/project" })).toBeUndefined()
  })

  test("keeps only sentences where the user says how things should be done from now on", () => {
    expect(MemoryRecorder.standingInstructions("帮我修这个 bug。以后都用 pnpm，不要用 npm。谢谢")).toEqual([
      "以后都用 pnpm，不要用 npm。",
    ])
    expect(
      MemoryRecorder.standingInstructions("From now on reply in Chinese. The button never works on mobile."),
    ).toEqual(["From now on reply in Chinese."])
    expect(MemoryRecorder.standingInstructions("这个按钮不要了，删掉")).toEqual([])
  })

  it.live("records a passed check and a standing instruction from the event stream", () =>
    Effect.gen(function* () {
      yield* setup
      const events = yield* EventV2.Service
      const store = yield* MemoryStore.Service
      yield* store.clear(project)
      const base = { timestamp: DateTime.makeUnsafe(1), sessionID: first }
      const tool = { ...base, assistantMessageID: SessionMessage.ID.make("msg_a"), provider: { executed: false } }
      yield* events.publish(SessionEvent.Tool.Called, {
        ...tool,
        callID: "c1",
        tool: "bash",
        input: { command: "bun typecheck" },
      })
      yield* events.publish(SessionEvent.Tool.Success, {
        ...tool,
        callID: "c1",
        structured: { exit: 0, truncated: false },
        content: [],
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        ...tool,
        callID: "c2",
        tool: "bash",
        input: { command: "bun test" },
      })
      yield* events.publish(SessionEvent.Tool.Success, {
        ...tool,
        callID: "c2",
        structured: { exit: 1, truncated: false },
        content: [],
      })
      yield* events.publish(SessionEvent.Prompted, {
        ...base,
        messageID: SessionMessage.ID.make("msg_u"),
        prompt: { text: "记住：提交前先跑类型检查", files: [], agents: [] },
        delivery: "steer",
      } as never)
      yield* Effect.sleep("200 millis")
      const notes = yield* store.list(project)
      expect(notes.map((note) => [note.kind, note.text, note.status]).toSorted()).toEqual([
        ["practice", "typecheck: `bun typecheck`", "unverified"],
        ["preference", "记住：提交前先跑类型检查", "verified"],
      ])
      expect(MemoryContext.lines(notes)).toEqual([
        expect.stringContaining("[preference] 记住：提交前先跑类型检查 (the user's own words; last seen "),
      ])
    }),
  )
})

describe("memory index", () => {
  test("holds only checked notes, the user's words first, within the size cap", () => {
    const note = (index: number, extra: object) => ({
      id: `mem_${index}` as never,
      scope: Memory.Scope.user,
      kind: "practice" as const,
      text: `note ${index} ${"x".repeat(100)}`,
      origin: "program" as const,
      status: "verified" as const,
      hits: 1,
      time: { created: 0, updated: 0, observed: index },
      ...extra,
    })
    const lines = MemoryContext.lines([
      ...Array.from({ length: 80 }, (_, index) => note(index, {})),
      note(900, { status: "unverified", text: "unchecked" }),
      note(901, { status: "stale", text: "stale" }),
      note(902, { kind: "preference", text: "用中文回答" }),
    ])
    expect(lines[0]).toContain("[preference] 用中文回答")
    expect(lines.join("\n")).not.toContain("unchecked")
    expect(lines.join("\n")).not.toContain("stale")
    expect(lines.length).toBeLessThanOrEqual(MemoryContext.maxLines)
    expect(Buffer.byteLength(lines.join("\n"))).toBeLessThanOrEqual(MemoryContext.maxBytes)
    expect(MemoryContext.render("Project memory", [])).toContain("No notes yet.")
  })
})
