import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Cause, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "../src/agent"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { PermissionV2 } from "../src/permission"
import { PermissionSaved } from "../src/permission/saved"
import { AppProcess } from "../src/process"
import { PluginV2 } from "../src/plugin"
import { PluginInternal } from "../src/plugin/internal"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { BashTool } from "../src/tool/bash"
import { ToolRegistry } from "../src/tool/registry"
import { tmpdir } from "./fixture/tmpdir"
import { location } from "./fixture/location"
import { probeShell } from "./fixture/probe-shell"
import { archiveInspection } from "./fixture/powershell-archive"
import { powerShellVariants } from "./fixture/powershell-variants"
import { settleTool, toolIdentity } from "./lib/tool"
import { modeAllowsPermission, type PermissionMode } from "../../app-ui/src/context/permission-auto-respond"

test("550 screenshot through real Bash/Permission: workspace automatic, full access and fresh deny all preserve dispatch boundaries", async () => {
  await using root = await tmpdir()
  await using outside = await tmpdir()
  const probe = await probeShell(root.path, "5.1.0", "powershell")
  const local = path.join(root.path, "input.xlsx")
  const external = path.join(outside.path, "input.xlsx")
  await Bun.write(local, "synthetic local fixture")
  await Bun.write(external, "synthetic external fixture")
  const runs: string[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const plugins = yield* PluginV2.Service
        yield* plugins.wait(PluginInternal.agentReadyID)
        const sessions = yield* SessionV2.Service
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make(root.path) } })
        const agents = yield* AgentV2.Service
        const permission = yield* PermissionV2.Service
        const registry = yield* ToolRegistry.Service
        const askRules: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "ask" }]
        const calls = { count: 0 }
        const policy = (rules: PermissionV2.Ruleset) =>
          agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [...rules]
            }),
          )
        const execute = Effect.fn("fixture.execute550")(function* (
          command: string,
          mode: PermissionMode,
          freshDeny: boolean | "directory" = false,
        ) {
          const before = runs.length
          const state = { visible: 0, requests: 0 }
          const observer = yield* Effect.gen(function* () {
            for (;;) {
              const requests = yield* permission.forSession(session.id)
              for (const request of requests) {
                state.requests++
                console.error(
                  "PERMISSION_550_REQUEST",
                  JSON.stringify({ mode, action: request.action, metadata: request.metadata }),
                )
                const automatic = modeAllowsPermission(mode, { permission: request.action, metadata: request.metadata })
                if (!automatic) state.visible++
                if (freshDeny)
                  yield* policy(
                    freshDeny === "directory"
                      ? [
                          { action: "*", resource: "*", effect: "allow" },
                          {
                            action: "external_directory",
                            resource: outside.path.replaceAll("\\", "/") + "/*",
                            effect: "deny",
                          },
                        ]
                      : [{ action: "*", resource: "*", effect: "deny" }],
                  )
                yield* permission
                  .reply({ requestID: request.id, reply: automatic ? "once" : "reject" })
                  .pipe(Effect.catch(() => Effect.void))
              }
              yield* Effect.sleep("5 millis")
            }
          }).pipe(Effect.forkScoped)
          calls.count++
          const type = yield* settleTool(registry, {
            sessionID: session.id,
            ...toolIdentity,
            call: { type: "tool-call", id: "case_" + calls.count, name: "bash", input: { command } },
          }).pipe(
            Effect.map((result) => result.result.type),
            Effect.catchCause((cause) =>
              Cause.squash(cause) instanceof PermissionV2.DeclinedError
                ? Effect.succeed("error" as const)
                : Effect.failCause(cause),
            ),
            Effect.timeout("10 seconds"),
          )
          yield* Fiber.interrupt(observer)
          return { type, dispatch: runs.length - before, ...state }
        })
        const fileURIs = (file: string) => {
          const uri = pathToFileURL(file).href
          return [
            `[IO.File]::ReadAllText(([Uri]"${uri}").LocalPath)`,
            `$u=New-Object Uri '${uri}'; Get-Content $u.LocalPath`,
            `$u=[System.Uri]::new('${uri}'); Get-Content $u.LocalPath`,
            ...(process.platform === "win32" ? [`Get-Content '${path.toNamespacedPath(file)}'`] : []),
          ]
        }
        for (const command of fileURIs(external)) {
          yield* policy(askRules)
          expect(yield* execute(command, "automatic"), command).toMatchObject({
            visible: 1,
            dispatch: 0,
            type: "error",
          })
          for (const rules of [
            [{ action: "*", resource: "*", effect: "deny" }],
            [
              { action: "*", resource: "*", effect: "allow" },
              { action: "external_directory", resource: outside.path.replaceAll("\\", "/") + "/*", effect: "deny" },
            ],
          ] satisfies PermissionV2.Ruleset[]) {
            yield* policy(rules)
            expect(yield* execute(command, "full"), command).toMatchObject({ visible: 0, dispatch: 0, type: "error" })
          }
        }
        for (const command of fileURIs(local)) {
          yield* policy(askRules)
          expect(yield* execute(command, "automatic"), command).toMatchObject({
            visible: 0,
            dispatch: 1,
            type: "content",
          })
          yield* policy(askRules)
          expect(yield* execute(command, "ask"), command).toMatchObject({ visible: 1, dispatch: 0, type: "error" })
        }
        yield* policy(askRules)
        expect(yield* execute("Get-Content 'file:///%ZZ'", "automatic")).toMatchObject({
          visible: 1,
          dispatch: 0,
          type: "error",
        })
        for (const mode of ["ask", "automatic", "full"] as const) {
          yield* policy(askRules)
          const result = yield* execute(archiveInspection(local), mode)
          expect(result.visible).toBe(mode === "ask" ? 1 : 0)
          expect(result.dispatch).toBe(mode === "ask" ? 0 : 1)
          expect(result.type).toBe(mode === "ask" ? "error" : "content")
        }
        yield* policy(askRules)
        for (const command of ["Get-Content $env:HOME", "Write-Output $unknown", archiveInspection(local)]) {
          expect(yield* execute(command, "full")).toMatchObject({ visible: 0, dispatch: 1, type: "content" })
        }
        yield* policy(askRules)
        const externalAsk = yield* execute(archiveInspection(external), "automatic")
        expect(externalAsk).toMatchObject({ visible: 1, dispatch: 0, type: "error" })
        yield* policy([
          { action: "*", resource: "*", effect: "allow" },
          { action: "external_directory", resource: outside.path.replaceAll("\\", "/") + "/*", effect: "deny" },
        ])
        const denied = yield* execute(archiveInspection(external), "full")
        expect(denied).toMatchObject({ visible: 0, dispatch: 0, type: "error" })
        yield* policy(askRules)
        const fresh = yield* execute(archiveInspection(local), "full", true)
        expect(fresh).toMatchObject({ visible: 0, dispatch: 0, type: "error" })
        yield* policy([{ action: "*", resource: "*", effect: "deny" }])
        expect(yield* execute(archiveInspection(local), "full")).toMatchObject({
          visible: 0,
          dispatch: 0,
          type: "error",
        })
        expect(yield* permission.forSession(session.id)).toEqual([])
        const variants = []
        for (const command of powerShellVariants(local)) {
          yield* policy(askRules)
          const result = yield* execute(command, "automatic")
          variants.push(result)
        }
        console.error("VARIANTS_562", JSON.stringify(variants))
        for (const result of variants) expect(result).toMatchObject({ visible: 0, dispatch: 1, type: "content" })
        for (const command of powerShellVariants(external)) {
          yield* policy(askRules)
          expect(yield* execute(command, "automatic")).toMatchObject({ visible: 1, dispatch: 0, type: "error" })
          yield* policy([
            { action: "*", resource: "*", effect: "allow" },
            { action: "external_directory", resource: outside.path.replaceAll("\\", "/") + "/*", effect: "deny" },
          ])
          expect(yield* execute(command, "full")).toMatchObject({ visible: 0, dispatch: 0, type: "error" })
        }
        yield* policy(askRules)
        expect(yield* execute(external, "automatic")).toMatchObject({ visible: 1, dispatch: 0, type: "error" })
        for (const mode of ["automatic", "full"] as const) {
          for (const rules of [
            [{ action: "*", resource: "*", effect: "deny" }],
            [
              { action: "*", resource: "*", effect: "allow" },
              { action: "external_directory", resource: "*", effect: "deny" },
            ],
            [
              { action: "*", resource: "*", effect: "allow" },
              { action: "external_directory", resource: outside.path.replaceAll("\\", "/") + "/*", effect: "deny" },
            ],
          ] satisfies PermissionV2.Ruleset[]) {
            yield* policy(rules)
            expect(yield* execute("Get-Content $unknown", mode)).toMatchObject({
              visible: 0,
              dispatch: 0,
              type: "error",
            })
          }
        }
        yield* policy(askRules)
        expect(yield* execute(powerShellVariants(local)[4], "automatic", "directory")).toMatchObject({
          visible: 0,
          dispatch: 0,
          type: "error",
        })
        yield* policy(askRules)
        expect(yield* execute(powerShellVariants(local)[4], "ask")).toMatchObject({
          visible: 1,
          dispatch: 0,
          type: "error",
        })
        expect(yield* permission.forSession(session.id)).toEqual([])
      }),
    ).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            Location.node,
            SessionV2.node,
            Database.node,
            AgentV2.node,
            PermissionV2.node,
            PermissionSaved.node,
            PluginV2.node,
            PluginInternal.node,
            BashTool.node,
            ToolRegistry.node,
            ToolRegistry.toolsNode,
          ]),
          [
            [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(root.path) }))],
            [
              Global.node,
              Global.layerWith({
                data: path.join(root.path, "data"),
                config: path.join(root.path, "config"),
                state: path.join(root.path, "state"),
              }),
            ],
            [SessionExecution.node, SessionExecution.noopLayer],
            [
              Config.node,
              Layer.succeed(
                Config.Service,
                Config.Service.of({
                  entries: () =>
                    Effect.succeed([
                      new Config.Document({ type: "document", info: new Config.Info({ shell: probe.executable }) }),
                    ]),
                }),
              ),
            ],
            [
              AppProcess.node,
              Layer.mock(AppProcess.Service, {
                run: (command) =>
                  Effect.sync(() => {
                    runs.push(command._tag)
                    return {
                      command: "permission-fixture550",
                      exitCode: 0,
                      output: Buffer.from("fixture"),
                      stdout: Buffer.from("fixture"),
                      stderr: Buffer.alloc(0),
                      outputTruncated: false,
                      stdoutTruncated: false,
                      stderrTruncated: false,
                    }
                  }),
              }),
            ],
          ],
        ),
      ),
    ),
  )
}, 30_000)
