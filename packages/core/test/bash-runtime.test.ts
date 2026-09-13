import { expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Config } from "@zaovra-ai/core/config"
import { Global } from "@zaovra-ai/core/global"
import { Location } from "@zaovra-ai/core/location"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { BashTool } from "@zaovra-ai/core/tool/bash"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const withRuntime = <A, E, R>(
  body: (directory: string, sessions: SessionV2.Interface, registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const agents = yield* AgentV2.Service
        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("build"), (agent) => {
            agent.permissions = [{ action: "bash", resource: "*", effect: "allow" }]
          }),
        )
        return yield* body(tmp.path, yield* SessionV2.Service, yield* ToolRegistry.Service)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([SessionV2.node, BashTool.node, AgentV2.node, ToolRegistry.node]), [
            [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
            [Global.node, Global.layerWith({ data: tmp.path })],
            [Config.node, Layer.succeed(Config.Service, { entries: () => Effect.succeed([]) })],
            [SessionExecution.node, SessionExecution.noopLayer],
            [
              ProjectV2.node,
              Layer.succeed(ProjectV2.Service, {
                resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
                directories: () => Effect.succeed([]),
                commit: () => Effect.void,
              }),
            ],
          ]),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

it.live("retains bytes beyond the shell preview cap in the registry-owned log", () =>
  withRuntime((directory, sessions, registry) =>
    Effect.gen(function* () {
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      const script = path.join(directory, "verbose.js")
      const content = "HEAD" + "x".repeat(700_000) + "MIDDLE" + "y".repeat(700_000) + "TAIL"
      yield* Effect.promise(() => Bun.write(script, `process.stdout.write(${JSON.stringify(content)})`))
      const result = yield* settleTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "verbose",
          name: "bash",
          input: { command: `"${process.execPath}" "${script}"` },
        },
      })
      expect(result.result.type).not.toBe("error")
      expect(result.output?.structured).toMatchObject({ truncated: true })
      expect(yield* Effect.promise(() => Bun.file(result.outputPaths![0]).text())).toBe(content)
    }),
  ),
)

it.live("background commands settle durably, enforce ownership, and stop with their Session", () =>
  withRuntime((directory, sessions, registry) =>
    Effect.gen(function* () {
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      const other = yield* sessions.create({ location: session.location })
      const script = path.join(directory, "background.js")
      yield* Effect.promise(() => Bun.write(script, "process.stdout.write('finished');"))
      const start = (id: string) =>
        settleTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id,
            name: "bash",
            input: { command: `"${process.execPath}" "${script}"`, run_in_background: true },
          },
        })
      const first = yield* start("background")
      const job = (first.output?.structured as { job_id: string }).job_id
      const observe = (sessionID: SessionV2.ID, action: string) =>
        settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: `observe-${action}`, name: "bash_job", input: { job_id: job, action } },
        })
      expect((yield* observe(other.id, "cancel")).result.type).toBe("error")
      const finished = yield* observe(session.id, "wait")
      expect(finished.output?.structured).toMatchObject({
        status: "completed",
      })
      expect(finished.output?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("finished") })
      expect(yield* Effect.promise(() => Bun.file(first.outputPaths![0]).text())).toBe("finished")
      expect(
        (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.type === "shell"),
      ).toHaveLength(1)
      yield* start("background")
      expect(
        (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.type === "shell"),
      ).toHaveLength(1)
      yield* Effect.promise(() => Bun.write(script, "process.stdout.write('running'); setInterval(() => {}, 1000)"))
      const second = yield* start("long")
      yield* sessions.interrupt(session.id)
      const stopped = yield* settleTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "stopped",
          name: "bash_job",
          input: { job_id: (second.output?.structured as { job_id: string }).job_id, action: "get" },
        },
      })
      expect(stopped.output?.structured).toMatchObject({ status: "cancelled" })
      const shells = (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.type === "shell")
      expect(shells.every((message) => message.time.completed !== undefined)).toBe(true)
    }),
  ),
)
