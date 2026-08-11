import { describe, expect } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { Location } from "@zaovra-ai/core/location"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { AgentPlugin } from "@zaovra-ai/core/plugin/agent"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const it = testEffect(AppNodeBuilder.build(AgentV2.node))

describe("AgentV2", () => {
  it.effect("starts without agents", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service

      expect(yield* agent.all()).toEqual([])
      expect(yield* agent.get(AgentV2.ID.make("build"))).toBeUndefined()
    }),
  )

  it.effect("materializes replayable agent transforms", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Reviews code"
          info.mode = "subagent"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, description: "Reviews code", mode: "subagent" })
      expect((yield* agent.all()).map((info) => info.id)).toEqual([id])
    }),
  )

  it.effect("rebuilds state when a transform is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      let description = "Old description"
      let hidden = true
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = description
          info.hidden = hidden
        }),
      )
      description = "New description"
      hidden = false
      yield* agent.reload()

      expect(yield* agent.get(id)).toMatchObject({ description: "New description", hidden: false })
    }),
  )

  it.effect("removes a transform when its scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("scoped")
      const scope = yield* Scope.make()
      yield* agent.transform((editor) => editor.update(id, () => {})).pipe(Scope.provide(scope))
      expect(yield* agent.get(id)).toBeDefined()

      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies direct agent updates", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("build")

      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.mode = "primary"
          info.hidden = true
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, mode: "primary", hidden: true })
    }),
  )

  it.effect("creates agents with runtime defaults and supports direct removal", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("custom")

      yield* agent.transform((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toEqual(AgentV2.Info.empty(id))

      yield* agent.transform((editor) => editor.remove(id))
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("does not ambiently opt built-in agents into bash", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const agents = yield* agent.all()
      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "build",
        "compaction",
        "explore",
        "general",
        "plan",
        "review",
        "summary",
        "title",
        "work-architect",
        "work-design-architect",
        "work-developer",
        "work-planner",
        "work-pm",
        "work-qa",
        "work-security",
      ])
      for (const item of agents) {
        expect(item.permissions.some((rule) => rule.action === "bash" && rule.effect !== "deny")).toBe(false)
      }
      const review = yield* agent.get(AgentV2.ID.make("review"))
      expect(review).toBeDefined()
      expect(PermissionV2.evaluate("edit", "src/index.ts", review?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("bash", "bun test", review?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("read", "src/index.ts", review?.permissions ?? []).effect).toBe("allow")
      const architect = yield* agent.get(AgentV2.ID.make("work-architect"))
      expect(architect).toMatchObject({ hidden: true, mode: "primary" })
      expect(PermissionV2.evaluate("edit", "src/index.ts", architect?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("read", "src/index.ts", architect?.permissions ?? []).effect).toBe("allow")
      const developer = yield* agent.get(AgentV2.ID.make("work-developer"))
      expect(developer).toMatchObject({ hidden: true, mode: "primary" })
      expect(PermissionV2.evaluate("edit", "src/index.ts", developer?.permissions ?? []).effect).toBe("allow")
      expect(PermissionV2.evaluate("task", "general", developer?.permissions ?? []).effect).toBe("deny")
      for (const id of ["work-pm", "work-design-architect", "work-qa", "work-security"]) {
        const role = yield* agent.get(AgentV2.ID.make(id))
        expect(PermissionV2.evaluate("edit", "src/index.ts", role?.permissions ?? []).effect).toBe("deny")
      }
      for (const id of [
        "review",
        "work-planner",
        "work-architect",
        "work-pm",
        "work-design-architect",
        "work-developer",
        "work-qa",
        "work-security",
      ]) {
        const role = yield* agent.get(AgentV2.ID.make(id))
        expect(role).toMatchObject({ hidden: true, mode: "primary" })
        expect(PermissionV2.evaluate("read", "src/index.ts", role?.permissions ?? []).effect).toBe("allow")
        expect(PermissionV2.evaluate("read", ".env", role?.permissions ?? []).effect).toBe("deny")
        expect(PermissionV2.evaluate("external_directory", "/outside", role?.permissions ?? []).effect).toBe("deny")
        expect(PermissionV2.evaluate("question", "*", role?.permissions ?? []).effect).toBe("deny")
      }
    }),
  )
})
