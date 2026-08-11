import { describe, expect } from "bun:test"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Location } from "@zaovra-ai/core/location"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionProjector } from "@zaovra-ai/core/session/projector"
import { SessionStore } from "@zaovra-ai/core/session/store"
import { TaskRecovery } from "@zaovra-ai/core/tool/task-recovery"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"

const woken: SessionV2.ID[] = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: (sessionID) => Effect.sync(() => woken.push(sessionID)),
    interrupt: () => Effect.void,
  }),
)
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, SessionProjector.node, SessionStore.node, SessionV2.node, TaskRecovery.node]),
  [
    [ProjectV2.node, projects],
    [SessionExecution.node, execution],
  ],
)
const it = testEffect(layer)

describe("TaskRecovery", () => {
  it.effect("wakes only a child prompt that was durably admitted but never promoted", () =>
    Effect.gen(function* () {
      woken.length = 0
      const sessions = yield* SessionV2.Service
      const recovery = yield* TaskRecovery.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
      const parent = yield* sessions.create({ id: SessionV2.ID.make("ses_recovery_parent"), location })
      const child = yield* sessions.create({
        id: SessionV2.ID.make("ses_recovery_child"),
        location,
        parentID: parent.id,
      })
      yield* sessions.prompt({ sessionID: child.id, prompt: { text: "Continue after restart" }, resume: false })

      expect(yield* recovery.recover()).toEqual([child.id])
      expect(woken).toEqual([child.id])
    }),
  )
})
