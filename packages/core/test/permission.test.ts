import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { Location } from "@zaovra-ai/core/location"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { PermissionTable } from "@zaovra-ai/core/permission/sql"
import { PermissionSaved } from "@zaovra-ai/core/permission/saved"
import { Project } from "@zaovra-ai/core/project"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionTable } from "@zaovra-ai/core/session/sql"
import { SessionStore } from "@zaovra-ai/core/session/store"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current]],
  ),
)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function waitForRequest() {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion()).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  for (const resource of [
    "ls example.py; echo unexpected.py",
    "ls example.py\necho unexpected.py",
    "ls $(echo unexpected).py",
    "ls example.py > unexpected.py",
    "ls example.py",
  ]) {
    it.effect(`490 saved shell literal does not authorize ${JSON.stringify(resource)}`, () =>
      Effect.gen(function* () {
        yield* setup()
        const service = yield* PermissionV2.Service
        const approved = yield* service.ask(assertion({ action: "bash", resources: ["ls *.py"], save: ["ls *.py"] }))
        yield* service.reply({ requestID: approved.id, reply: "always" })
        expect(yield* service.ask(assertion({ action: "bash", resources: ["ls *.py"] }))).toMatchObject({
          effect: "allow",
        })
        expect(yield* service.ask(assertion({ action: "bash", resources: [resource] }))).toMatchObject({
          effect: "ask",
        })
      }),
    )
  }

  for (const resource of ["LS *.py", "ls /folder/*.py", "ls \\folder\\*.py", "ls *.py "]) {
    it.effect(`490 literal keeps case, slashes and whitespace ${JSON.stringify(resource)}`, () =>
      Effect.gen(function* () {
        yield* setup()
        const service = yield* PermissionV2.Service
        const approved = yield* service.ask(assertion({ action: "bash", resources: ["ls *.py"], save: ["ls *.py"] }))
        yield* service.reply({ requestID: approved.id, reply: "always" })
        expect(yield* service.ask(assertion({ action: "bash", resources: [resource] }))).toMatchObject({
          effect: "ask",
        })
      }),
    )
  }

  it.effect("490 preserves unclassified legacy rows and requires a new approval", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .insert(PermissionTable)
        .values({ id: PermissionSaved.ID.create(), project_id: Project.ID.global, action: "bash", resource: "ls *.py" })
        .run()
        .pipe(Effect.orDie)
      const service = yield* PermissionV2.Service
      const approved = yield* service.ask(assertion({ action: "bash", resources: ["ls *.py"], save: ["ls *.py"] }))
      expect(approved.effect).toBe("ask")
      yield* service.reply({ requestID: approved.id, reply: "always" })
      const saved = yield* PermissionSaved.Service
      expect(yield* saved.list()).toMatchObject([
        { action: "bash", resource: "ls *.py", matchMode: "legacy", origin: "legacy", version: 1 },
        { action: "bash", resource: "ls *.py", matchMode: "literal", origin: "internal", version: 2 },
      ])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["ls *.py"] }))).toMatchObject({
        effect: "allow",
      })
      expect(yield* service.ask(assertion({ action: "bash", resources: ["ls x.py"] }))).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("490 new API approvals cannot become wildcard actions or commands", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const approved = yield* service.ask(
        assertion({ action: "*", resources: ["*"], save: ["*"], saveMode: "literal", origin: "api" }),
      )
      yield* service.reply({ requestID: approved.id, reply: "always" })
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("490 same-directory pending requests in a different project remain isolated", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.make("project_other"), worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionV2.ID.make("ses_project_other"),
          project_id: Project.ID.make("project_other"),
          slug: "other",
          directory: "/project",
          title: "other",
          version: "test",
          agent: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const original = yield* PermissionV2.Service
      const first = yield* original.ask(assertion({ action: "bash", resources: ["pwd"], save: ["pwd"] }))
      yield* Effect.gen(function* () {
        yield* setRules([])
        const other = yield* PermissionV2.Service
        const second = yield* other.ask(
          assertion({
            id: PermissionV2.ID.create("per_other_project"),
            sessionID: SessionV2.ID.make("ses_project_other"),
            action: "bash",
            resources: ["pwd"],
          }),
        )
        yield* original.reply({ requestID: first.id, reply: "always" })
        expect(yield* other.get(second.id)).toBeDefined()
        expect(yield* original.get(second.id)).toBeUndefined()
        yield* other.reply({ requestID: second.id, reply: "reject" })
      }).pipe(
        Effect.provide(Layer.fresh(PermissionV2.locationLayer)),
        Effect.provideService(
          Location.Service,
          Location.Service.of({
            ...location({ directory: AbsolutePath.make("/project") }),
            project: { id: Project.ID.make("project_other"), directory: AbsolutePath.make("/project") },
          }),
        ),
      )
    }),
  )

  it.effect("490 literal Windows paths never normalize backslashes into slashes", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const command = "echo C:\\temp\\*.py"
      const approved = yield* service.ask(assertion({ action: "bash", resources: [command], save: [command] }))
      yield* service.reply({ requestID: approved.id, reply: "always" })
      expect(yield* service.ask(assertion({ action: "bash", resources: [command] }))).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ action: "bash", resources: ["echo C:/temp/*.py"] }))).toMatchObject({
        effect: "ask",
      })
    }),
  )

  it.effect("490 exact pending replies coalesce, but a changed deny still blocks", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const first = yield* service.ask(assertion({ action: "bash", resources: ["pwd"], save: ["pwd"] }))
      const second = yield* service.ask(
        assertion({ id: PermissionV2.ID.create("per_exact"), action: "bash", resources: ["pwd"] }),
      )
      yield* service.reply({ requestID: first.id, reply: "always" })
      expect(yield* service.get(second.id)).toBeUndefined()
      yield* setRules([{ action: "bash", resource: "pwd", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("490 cancelling a pending command removes its approval before always can save it", () =>
    Effect.gen(function* () {
      yield* setup()
      const waiting = yield* waitForRequest()
      yield* Fiber.interrupt(waiting.fiber)
      expect(yield* waiting.service.get(waiting.request.id)).toBeUndefined()
      expect(
        yield* waiting.service.reply({ requestID: waiting.request.id, reply: "always" }).pipe(Effect.flip),
      ).toBeInstanceOf(PermissionV2.NotFoundError)
      const saved = yield* PermissionSaved.Service
      expect(yield* saved.list()).toEqual([])
    }),
  )

  it.effect("490 always reply leaves another Session's expanded command pending", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionV2.ID.make("ses_second"),
          project_id: Project.ID.global,
          slug: "second",
          directory: "/project",
          title: "second",
          version: "test",
          agent: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const service = yield* PermissionV2.Service
      const expanded = yield* service.ask(
        assertion({
          id: PermissionV2.ID.create("per_expanded"),
          sessionID: SessionV2.ID.make("ses_second"),
          action: "bash",
          resources: ["ls x.py; echo unexpected.py"],
        }),
      )
      const approved = yield* service.ask(assertion({ action: "bash", resources: ["ls *.py"], save: ["ls *.py"] }))
      yield* service.reply({ requestID: approved.id, reply: "always" })
      expect(yield* service.get(expanded.id)).toBeDefined()
    }),
  )

  it.effect("rejects an approval after its configured rules change to deny", () =>
    Effect.gen(function* () {
      yield* setup()
      const waiting = yield* waitForRequest()
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      yield* waiting.service.reply({ requestID: waiting.request.id, reply: "always" })
      const exit = yield* Fiber.await(waiting.fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV2.CorrectedError)
      const saved = yield* PermissionSaved.Service
      expect(yield* saved.list()).toEqual([])
      expect(yield* waiting.service.list()).toEqual([])
    }),
  )

  it.effect("does not apply always-allow replies to another Location's pending requests", () =>
    Effect.gen(function* () {
      yield* setup()
      const original = yield* PermissionV2.Service
      const first = yield* original.ask(assertion({ save: ["src/*"] }))
      yield* Effect.gen(function* () {
        yield* setRules([])
        const other = yield* PermissionV2.Service
        const second = yield* other.ask(assertion({ id: PermissionV2.ID.create("per_other") }))
        expect(other).not.toBe(original)
        expect(second.effect).toBe("ask")
        expect(yield* other.get(second.id)).toBeDefined()
        yield* original.reply({ requestID: first.id, reply: "always" })
        expect(yield* other.get(second.id)).toBeDefined()
        yield* other.reply({ requestID: second.id, reply: "reject" })
      }).pipe(
        Effect.provide(Layer.fresh(PermissionV2.locationLayer)),
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/other") })),
        ),
      )
    }),
  )

  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(PermissionV2.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({
        projectID: Project.ID.global,
        action: "bash",
        resources: ["pwd"],
        matchMode: "literal",
        origin: "internal",
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([
        {
          id,
          projectID: Project.ID.global,
          action: "read",
          resource: "src/*",
          matchMode: "pattern",
          origin: "internal",
          version: 2,
        },
      ])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )
})

test("490 saved literal and unclassified legacy survive database close and restart", async () => {
  await using root = await tmpdir()
  for (const phase of ["save", "restart"]) {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* setup()
        const service = yield* PermissionV2.Service
        const saved = yield* PermissionSaved.Service
        if (phase === "save") {
          const { db } = yield* Database.Service
          yield* db
            .insert(PermissionTable)
            .values({
              id: PermissionSaved.ID.create(),
              project_id: Project.ID.global,
              action: "bash",
              resource: "ls *.py",
            })
            .run()
            .pipe(Effect.orDie)
          const approved = yield* service.ask(assertion({ action: "bash", resources: ["ls *.py"], save: ["ls *.py"] }))
          yield* service.reply({ requestID: approved.id, reply: "always" })
          return
        }
        expect(yield* saved.list()).toMatchObject([
          { matchMode: "legacy", origin: "legacy", version: 1 },
          { matchMode: "literal", origin: "internal", version: 2 },
        ])
        expect(yield* service.ask(assertion({ action: "bash", resources: ["ls *.py"] }))).toMatchObject({
          effect: "allow",
        })
        expect(yield* service.ask(assertion({ action: "bash", resources: ["ls unexpected.py"] }))).toMatchObject({
          effect: "ask",
        })
        const literal = (yield* saved.list()).find((item) => item.matchMode === "literal")!
        yield* saved.remove(literal.id)
        expect(
          yield* service.ask(
            assertion({ id: PermissionV2.ID.create("per_restart"), action: "bash", resources: ["ls *.py"] }),
          ),
        ).toMatchObject({ effect: "ask" })
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              Database.node,
              EventV2.node,
              SessionStore.node,
              PermissionSaved.node,
              AgentV2.node,
              PermissionV2.node,
            ]),
            [
              [Location.node, current],
              [Database.node, Database.layerFromPath(path.join(root.path, "permissions.sqlite"))],
            ],
          ),
        ),
      ),
    )
  }
})
