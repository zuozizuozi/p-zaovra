import { SessionMessage } from "../../src/session/message"
import path from "node:path"
import { Effect, Layer, Logger } from "effect"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "../../src/effect/layer-node"
import { SessionV2 } from "../../src/session"
import { SessionExecution } from "../../src/session/execution"
import { SessionBudget } from "../../src/session/budget"
import { BashTool } from "../../src/tool/bash"
import { BashJob } from "../../src/tool/bash-job"
import { ToolRegistry } from "../../src/tool/registry"
import { BackgroundJob } from "../../src/background-job"
import { AgentV2 } from "../../src/agent"
import { Config } from "../../src/config"
import { Global } from "../../src/global"
import { Location } from "../../src/location"
import { AbsolutePath } from "../../src/schema"
import { ProjectV2 } from "../../src/project"
import { Database } from "../../src/database/database"
import { location } from "./location"
import { settleTool, toolIdentity } from "../lib/tool"

const [root, mode] = process.argv.slice(2)
const stateFile = path.join(root, "state.json")
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service
      const agents = yield* AgentV2.Service
      const config = yield* Config.Service
      const db = yield* Database.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "bash", resource: "*", effect: "allow" }]
        }),
      )
      if (mode.startsWith("start")) {
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make(root) } })
        yield* sessions.update({ sessionID: session.id, budget: { tokens: 123, durationMs: 4567 } })
        const ready = path.join(root, "ready.json")
        const script = path.resolve(import.meta.dir, "service-server.ts")
        const result = yield* settleTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "restart-service",
            name: "bash",
            input: {
              command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}" "${ready}" http`,
              run_in_background: true,
              background_kind: "preview",
              ...(mode === "start-wait" ? { hard_timeout_ms: 8000 } : {}),
              workdir: root,
            },
          },
        })
        if (result.result.type === "error") throw new Error(String(result.result.value))
        const jobID = String((result.output?.structured as { job_id?: string })?.job_id)
        const deadline = Date.now() + 5000
        while (!(yield* Effect.promise(() => Bun.file(ready).exists()))) {
          if (Date.now() > deadline) throw new Error("HTTP fixture did not listen")
          yield* Effect.sleep(20)
        }
        yield* Effect.promise(() => Bun.write(stateFile, JSON.stringify({ sessionID: session.id, jobID })))
        return
      }
      const saved = yield* Effect.promise(
        () => Bun.file(stateFile).json() as Promise<{ sessionID: string; jobID: string }>,
      )
      const sessionID = SessionV2.ID.make(saved.sessionID)
      const observe = (id: SessionV2.ID, action: string) =>
        settleTool(registry, {
          sessionID: id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: `restart-${action}`,
            name: "bash_job",
            input: { job_id: saved.jobID, action, timeout: mode === "wait" ? 10000 : 10 },
          },
        })
      if ((yield* jobs.get(saved.jobID)) !== undefined)
        throw new Error("Restart accidentally retained the in-memory registry")
      if (
        JSON.stringify(yield* SessionBudget.read(db.db, config, sessionID)) !==
        JSON.stringify({ limit: 123, duration: 4567 })
      )
        throw new Error("Budget provenance/overrides lost across process restart")
      if ((yield* sessions.outcome(sessionID)).state !== "idle")
        throw new Error("Owned persistent preview blocks a new drain after restart")
      const queried = yield* observe(sessionID, "get")
      if ((queried.output?.structured as { status?: string })?.status !== "running")
        throw new Error("Restart query did not find the owned service")
      const other = yield* sessions.create({ location: { directory: AbsolutePath.make(root) } })
      if ((yield* observe(other.id, "cancel")).result.type !== "error")
        throw new Error("Another Session could cancel the service")
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "bash", resource: "*", effect: "deny" }]
        }),
      )
      if ((yield* observe(sessionID, "cancel")).result.type !== "error")
        throw new Error("Denied shell permission could cancel the service")
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "bash", resource: "*", effect: "allow" }]
        }),
      )
      if (mode === "archive") yield* sessions.update({ sessionID, archived: true })
      if (mode === "wait") {
        if (((yield* observe(sessionID, "wait")).output?.structured as { status?: string })?.status !== "error")
          throw new Error("Persistent hard deadline was not observed by blocking wait")
        const message = yield* sessions.message({ sessionID, messageID: SessionMessage.ID.make(saved.jobID) })
        if (message?.type !== "shell" || !message.time.completed)
          throw new Error("Recovered wait did not settle durable shell history")
      }
      if (mode === "cancel") {
        if (((yield* observe(sessionID, "wait")).output?.structured as { status?: string })?.status !== "running")
          throw new Error("Wait fabricated a terminal result")
        if (((yield* observe(sessionID, "cancel")).output?.structured as { status?: string })?.status !== "cancelled")
          throw new Error("Restart cancellation failed")
      }
      yield* Effect.promise(() =>
        Bun.write(
          path.join(root, "managed.json"),
          JSON.stringify({
            mode,
            query: "running",
            permissionDenied: true,
            otherSessionDenied: true,
            budget: "preserved",
            registry: "empty",
          }),
        ),
      )
    }),
  ).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          SessionV2.node,
          BashTool.node,
          BashJob.node,
          AgentV2.node,
          ToolRegistry.node,
          BackgroundJob.node,
          Database.node,
          Config.node,
        ]),
        [
          [Global.node, Global.layerWith({ data: root })],
          [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(root) }))],
          [
            Config.node,
            Layer.succeed(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([
                    new Config.Document({
                      type: "document",
                      info: new Config.Info({ shell: process.platform === "win32" ? "powershell" : "bash" }),
                    }),
                  ]),
              }),
            ),
          ],
          [SessionExecution.node, SessionExecution.noopLayer],
          [
            ProjectV2.node,
            Layer.succeed(ProjectV2.Service, {
              resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
              directories: () => Effect.succeed([]),
              commit: () => Effect.void,
            }),
          ],
        ],
      ),
    ),
    Effect.provide(Logger.layer([])),
  ),
)
