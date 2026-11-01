import { expect } from "bun:test"
import path from "node:path"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { BackgroundJob } from "@zaovra-ai/core/background-job"
import { Config } from "@zaovra-ai/core/config"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { Global } from "@zaovra-ai/core/global"
import { Location } from "@zaovra-ai/core/location"
import { AppProcess } from "@zaovra-ai/core/process"
import { PreviewProcess } from "@zaovra-ai/core/preview-process"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { BashTool } from "@zaovra-ai/core/tool/bash"
import { BashJob } from "@zaovra-ai/core/tool/bash-job"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"
import { settleToolApproved } from "./fixture/approve-tool"

const it = testEffect(Layer.empty)

for (const action of ["owner-close", "cancel", "archive"] as const)
  it.live(
    `113 unsupported preview uses the real BashJob owner scope: ${action}`,
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const owner = yield* Scope.make()
            const runtime = yield* Layer.buildWithScope(
              AppNodeBuilder.build(
                LayerNode.group([
                  SessionV2.node,
                  BashTool.node,
                  BashJob.node,
                  AgentV2.node,
                  ToolRegistry.node,
                  PermissionV2.node,
                  BackgroundJob.node,
                  Database.node,
                  EventV2.node,
                ]),
                [
                  [
                    Location.node,
                    Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) })),
                  ],
                  [Global.node, Global.layerWith({ data: tmp.path })],
                  [
                    Config.node,
                    Layer.succeed(Config.Service, {
                      entries: () =>
                        Effect.succeed([
                          new Config.Document({
                            type: "document",
                            info: new Config.Info({ shell: process.platform === "win32" ? "powershell" : "/bin/sh" }),
                          }),
                        ]),
                    }),
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
              owner,
            )
            const sessions = Context.get(runtime, SessionV2.Service)
            const registry = Context.get(runtime, ToolRegistry.Service)
            const jobs = Context.get(runtime, BackgroundJob.Service)
            const agents = Context.get(runtime, AgentV2.Service)
            const owned: string[] = []
            yield* Effect.gen(function* () {
              yield* agents.transform((editor) =>
                editor.update(AgentV2.ID.make("build"), (agent) => {
                  agent.permissions = [{ action: "bash", resource: "*", effect: "allow" }]
                }),
              )
              const start = Effect.fn(function* (name: string) {
                const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
                const ready = path.join(tmp.path, `${name}.json`)
                const script = path.join(tmp.path, `${name}.cjs`)
                yield* Effect.promise(() =>
                  Bun.write(
                    script,
                    `const s=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({name:${JSON.stringify(name)},pid:process.pid})});const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready + ".tmp")},JSON.stringify({pid:process.pid,port:s.port}));fs.renameSync(${JSON.stringify(ready + ".tmp")},${JSON.stringify(ready)});`,
                  ),
                )
                const result = yield* settleToolApproved(registry, {
                  sessionID: session.id,
                  ...toolIdentity,
                  call: {
                    type: "tool-call",
                    id: name,
                    name: "bash",
                    input: {
                      command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`,
                      workdir: tmp.path,
                      background_kind: "preview",
                      run_in_background: true,
                      hard_timeout_ms: 10000,
                    },
                  },
                })
                const job = (result.output?.structured as { job_id?: string } | undefined)?.job_id
                expect(job).toBeDefined()
                owned.push(job!)
                const child = yield* Effect.promise(async () => {
                  const deadline = Date.now() + 5000
                  while (!(await Bun.file(ready).exists())) {
                    if (Date.now() >= deadline) throw new Error(`Preview did not start: ${JSON.stringify(result)}`)
                    await Bun.sleep(10)
                  }
                  return Bun.file(ready).json() as Promise<{ pid: number; port: number }>
                })
                const url = `http://127.0.0.1:${child.port}`
                expect(yield* Effect.promise(() => fetch(url).then((response) => response.json()))).toEqual({
                  name,
                  pid: child.pid,
                })
                expect((yield* jobs.get(job!))?.status).toBe("running")
                return { session, job: job!, url, pid: child.pid }
              })
              const first = yield* start("first")
              const other = yield* start("other")
              if (action !== "owner-close") {
                const rejected = yield* settleToolApproved(registry, {
                  sessionID: other.session.id,
                  ...toolIdentity,
                  call: {
                    type: "tool-call",
                    id: "foreign-cancel",
                    name: "bash_job",
                    input: { action: "cancel", job_id: first.job },
                  },
                })
                expect(rejected.result.type).toBe("error")
                expect(yield* reachable(first.url)).toBe(true)
                if (action === "cancel")
                  yield* settleToolApproved(registry, {
                    sessionID: first.session.id,
                    ...toolIdentity,
                    call: {
                      type: "tool-call",
                      id: "own-cancel",
                      name: "bash_job",
                      input: { action: "cancel", job_id: first.job },
                    },
                  })
                if (action === "archive") yield* sessions.update({ sessionID: first.session.id, archived: true })
                expect((yield* jobs.get(first.job))?.status).toBe("cancelled")
                expect(yield* reachable(first.url)).toBe(false)
                if (process.platform === "win32" || process.platform === "linux")
                  expect(yield* Effect.promise(() => PreviewProcess.birth(first.pid))).toBeUndefined()
                expect(yield* reachable(other.url)).toBe(true)
              }
              yield* Scope.close(owner, Exit.void)
              expect(yield* reachable(first.url)).toBe(false)
              expect(yield* reachable(other.url)).toBe(false)
              if (process.platform === "win32" || process.platform === "linux") {
                expect(yield* Effect.promise(() => PreviewProcess.birth(first.pid))).toBeUndefined()
                expect(yield* Effect.promise(() => PreviewProcess.birth(other.pid))).toBeUndefined()
              }
            }).pipe(
              Effect.provideService(PermissionV2.Service, Context.get(runtime, PermissionV2.Service)),
              // The failing baseline is detached; retain its actual job handle for safe fixture cleanup.
              Effect.ensuring(Effect.forEach(owned, (id) => jobs.cancel(id), { discard: true })),
              Effect.ensuring(Scope.close(owner, Exit.void)),
            )
          }).pipe(Effect.provideService(AppProcess.PreviewPlatform, "darwin")),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    20000,
  )

function reachable(url: string) {
  return Effect.promise(() =>
    fetch(url).then(
      () => true,
      () => false,
    ),
  )
}
