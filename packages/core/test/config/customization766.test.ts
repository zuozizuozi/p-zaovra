import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect, Exit, Layer, Scope } from "effect"
import { parse, applyEdits, modify } from "jsonc-parser"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "../../src/effect/layer-node"
import { Config } from "../../src/config"
import { ConfigFile } from "../../src/config/file"
import { ConfigCustomization } from "../../src/config/customization"
import { ConfigSkillPlugin } from "../../src/config/plugin/skill"
import { FSUtil } from "../../src/fs-util"
import { Global } from "../../src/global"
import { Location } from "../../src/location"
import { AbsolutePath } from "../../src/schema"
import { SkillV2 } from "../../src/skill"
import { AgentV2 } from "../../src/agent"
import { CommandV2 } from "../../src/command"
import { CommandSources } from "../../src/command-sources"
import { MCP } from "../../src/mcp"
import { PermissionV2 } from "../../src/permission"
import { ApplicationTools } from "../../src/tool/application-tools"
import { ToolRegistry } from "../../src/tool/registry"
import { ToolOutputStore } from "../../src/tool-output-store"
import { SessionV2 } from "../../src/session"
import { location } from "../fixture/location"
import { host } from "../plugin/host"
import { executeTool, toolIdentity } from "../lib/tool"

const root = process.env.ZAOVRA_766_TEST_ROOT ?? ""
if (root && !path.isAbsolute(root)) throw new Error("An isolated absolute test root is required")
const isolated = root ? test : test.skip
if (root) await fs.mkdir(root, { recursive: true })
const file = path.join(root, "zaovra.jsonc")
const approvals: PermissionV2.AssertInput[] = []
const layer = AppNodeBuilder.build(
  LayerNode.group([
    FSUtil.node,
    Global.node,
    Location.node,
    Config.node,
    SkillV2.node,
    AgentV2.node,
    CommandV2.node,
    MCP.node,
    ApplicationTools.node,
    ToolRegistry.node,
  ]),
  [
    [Global.node, Global.layerWith({ config: root, home: path.join(root, "home") })],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(root) }))),
    ],
    [
      PermissionV2.node,
      Layer.mock(PermissionV2.Service, {
        assert: (input) =>
          Effect.sync(() => {
            approvals.push(input)
          }),
      }),
    ],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ],
)
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer> | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layer)))
const setup = Effect.gen(function* () {
  const skills = yield* SkillV2.Service
  yield* ConfigSkillPlugin.Plugin.effect(
    host({
      skill: {
        transform: (callback) => skills.transform((draft) => callback({ source: draft.source, list: draft.list })),
        reload: skills.reload,
      },
    }),
  )
  const agents = yield* AgentV2.Service
  yield* agents.transform((draft) =>
    draft.update(AgentV2.ID.make("build"), (agent) => {
      agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
    }),
  )
})

isolated("766 concurrent MCP edits share the existing writer and preserve unrelated JSONC", async () => {
  await Bun.write(file, '// keep comment\n{"model":"synthetic/model","mcp":{"servers":{}}}')
  await run(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      yield* Effect.all(
        [
          ConfigCustomization.updateMCP("first", {
            type: "remote",
            url: "http://127.0.0.1:1/mcp",
            disabled: true,
            headers: { "x-fixture": "synthetic" },
          }),
          ConfigCustomization.updateMCP("second", {
            type: "local",
            command: [process.execPath, "fixture"],
            disabled: true,
          }),
          ConfigFile.update(fs, file, (text) =>
            Effect.succeed(applyEdits(text!, modify(text!, ["model"], "synthetic/new-model", {}))),
          ),
        ],
        { concurrency: "unbounded" },
      )
    }),
  )
  const text = await Bun.file(file).text()
  expect(text).toContain("// keep comment")
  expect(parse(text).model).toBe("synthetic/new-model")
  expect(Object.keys(parse(text).mcp.servers).sort()).toEqual(["first", "second"])
  await run(ConfigCustomization.toggleMCP("first", true))
  expect(parse(await Bun.file(file).text()).mcp.servers.first.headers).toEqual({ "x-fixture": "synthetic" })
  expect(parse(await Bun.file(file).text()).mcp.servers.first.disabled).toBe(false)
})

isolated("766 duplicate, invalid and failed writes leave the original configuration intact", async () => {
  await Bun.write(file, '{"mcp":{"servers":{"first":{"type":"remote","url":"http://127.0.0.1:1","disabled":false}}}}')
  const before = await Bun.file(file).text()
  for (const mutation of [
    ConfigCustomization.updateMCP("first", { type: "remote", url: "http://127.0.0.1:1" }),
    ConfigCustomization.updateMCP("bad", { type: "remote", url: "file:///no" }),
    ConfigCustomization.updateMCP("bad", { type: "local", command: [""] }),
    ConfigCustomization.toggleMCP("missing", false),
  ])
    expect(Exit.isFailure(await run(Effect.exit(mutation)))).toBe(true)
  expect(await Bun.file(file).text()).toBe(before)
  await run(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const failed = FSUtil.Service.of({
        ...fs,
        writeFileString: () => fs.writeFileString(path.join(root, "missing-parent", "config"), "failed"),
      })
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            ConfigCustomization.toggleMCP("first", false).pipe(Effect.provideService(FSUtil.Service, failed)),
          ),
        ),
      ).toBe(true)
    }),
  )
  expect(await Bun.file(file).text()).toBe(before)
})

isolated("766 actual skill sources refresh, persist disabled state and retain agent deny", async () => {
  await fs.mkdir(path.join(root, ".zaovra/skills/review766"), { recursive: true })
  await Bun.write(
    path.join(root, ".zaovra/skills/review766/SKILL.md"),
    "---\nname: review766\ndescription: Fixture\n---\nLiteral $1 $ARGUMENTS",
  )
  await Bun.write(file, '{"mcp":{"servers":{}},"skills":["./.zaovra/skills"]}')
  await run(
    Effect.gen(function* () {
      yield* setup
      expect((yield* ConfigCustomization.list()).skills.map((item) => item.name)).toContain("review766")
      expect((yield* CommandSources.render("skill:review766", "extra", "build")).template).toContain(
        "Literal $1 $ARGUMENTS",
      )
      const agents = yield* AgentV2.Service
      yield* agents.transform((draft) =>
        draft.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions.push({ action: "skill", resource: "review766", effect: "deny" })
        }),
      )
      expect(Exit.isFailure(yield* Effect.exit(CommandSources.render("skill:review766", "", "build")))).toBe(true)
      yield* ConfigCustomization.toggleSkill("review766", false)
    }),
  )
  expect(parse(await Bun.file(file).text()).disabled_skills).toEqual(["review766"])
  await run(
    Effect.gen(function* () {
      yield* setup
      expect((yield* ConfigCustomization.list()).skills.find((item) => item.name === "review766")?.disabled).toBe(true)
      expect((yield* CommandSources.list()).some((item) => item.source === "skill")).toBe(false)
      expect(Exit.isFailure(yield* Effect.exit(CommandSources.render("skill:review766", "", "build")))).toBe(true)
      yield* ConfigCustomization.toggleSkill("review766", true)
      yield* Effect.promise(() =>
        Bun.write(path.join(root, ".zaovra/skills/new.md"), "---\nname: discovered766\n---\nNew source"),
      )
      expect((yield* ConfigCustomization.list()).skills.map((item) => item.name)).toContain("discovered766")
    }),
  )
  expect(parse(await Bun.file(file).text()).disabled_skills).toEqual([])
})

isolated(
  "766 actual MCP prompt discovery, arguments, notifications, deny and real tool call",
  async () => {
    await Bun.write(
      file,
      JSON.stringify({
        mcp: {
          servers: {
            local766: {
              type: "local",
              command: [process.execPath, path.resolve(import.meta.dir, "../fixture/customization766-mcp.ts")],
              environment: { ZAOVRA_766_MCP_LOG: path.join(root, "protocol.ndjson") },
            },
          },
        },
      }),
    )
    await run(
      Effect.gen(function* () {
        yield* setup
        const commands = yield* CommandV2.Service
        yield* commands.transform((draft) =>
          draft.update("ordinary", (command) => {
            command.template = "unchanged"
          }),
        )
        const list = yield* CommandSources.list()
        expect(list.find((item) => item.name === "ordinary")?.template).toBe("unchanged")
        expect(list.find((item) => item.name === "mcp:local766:review")?.hints).toEqual(["<target>"])
        expect((yield* CommandSources.render("mcp:local766:pair", '"a b" c', "build")).template).toContain(
          '{"first":"a b","second":"c"}',
        )
        expect(Exit.isFailure(yield* Effect.exit(CommandSources.render("mcp:local766:review", "", "build")))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(CommandSources.render("mcp:local766:pair", "a b c", "build")))).toBe(
          true,
        )
        expect((yield* CommandSources.render("mcp:local766:review", "notify", "build")).template).toContain("notify")
        expect((yield* CommandSources.list()).some((item) => item.name === "mcp:local766:added")).toBe(true)
        const registry = yield* ToolRegistry.Service
        approvals.length = 0
        expect(
          yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_customization766"),
            ...toolIdentity,
            call: { type: "tool-call", id: "766-call", name: "mcp_local766_echo", input: { text: "actual protocol" } },
          }),
        ).toEqual({ type: "text", value: "echo:actual protocol" })
        expect(approvals[0]?.action).toBe("mcp_local766_echo")
        const agents = yield* AgentV2.Service
        yield* agents.transform((draft) =>
          draft.update(AgentV2.ID.make("build"), (agent) => {
            agent.permissions.push({ action: "read", resource: "mcp:local766:prompt:*", effect: "deny" })
          }),
        )
        expect(
          Exit.isFailure(yield* Effect.exit(CommandSources.render("mcp:local766:review", "blocked", "build"))),
        ).toBe(true)
        const mcp = yield* MCP.Service
        expect(Exit.isFailure(yield* Effect.exit(mcp.renderPrompt("local766", "image", {})))).toBe(true)
      }),
    )
  },
  30000,
)

isolated(
  "766 a transient MCP prompt list failure can recover on refresh",
  async () => {
    await Bun.write(
      file,
      JSON.stringify({
        mcp: {
          servers: {
            retry766: {
              type: "local",
              command: [process.execPath, path.resolve(import.meta.dir, "../fixture/customization766-mcp.ts")],
              environment: { ZAOVRA_766_PROMPT_FAIL_ONCE: "1" },
            },
          },
        },
      }),
    )
    await run(
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect(yield* mcp.prompts()).toEqual([])
        expect((yield* mcp.prompts()).map((item) => item.name)).toContain("review")
      }),
    )
  },
  30000,
)

isolated("766 legacy MCP edits preserve existing servers and unrelated raw configuration", async () => {
  await Bun.write(
    file,
    '// outer comment\n{"user_note":{"keep":true},"mcp":{"old":{"type":"remote","url":"http://127.0.0.1:1/mcp","headers":{"x-fixture":"synthetic"},"enabled":false}}}',
  )
  await run(
    ConfigCustomization.updateMCP("added", { type: "local", command: [process.execPath, "fixture"], disabled: true }),
  )
  const text = await Bun.file(file).text()
  const result = parse(text)
  expect(text).toContain("// outer comment")
  expect(result.user_note).toEqual({ keep: true })
  expect(result.mcp.servers.old.url).toBe("http://127.0.0.1:1/mcp")
  expect(result.mcp.servers.old.disabled).toBe(true)
  expect(result.mcp.servers.old.headers).toEqual({ "x-fixture": "synthetic" })
  expect(result.mcp.servers.added.disabled).toBe(true)
})

isolated("766 injected MCP configuration refuses persistence without a shadow override", async () => {
  const before = await Bun.file(file).text()
  const injected = Config.Service.of({
    entries: () =>
      Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({ mcp: { servers: {} } }) })]),
  })
  expect(
    Exit.isFailure(
      await run(
        Effect.exit(
          ConfigCustomization.updateMCP("blocked", { type: "local", command: [process.execPath], disabled: true }).pipe(
            Effect.provideService(Config.Service, injected),
          ),
        ),
      ),
    ),
  ).toBe(true)
  expect(await Bun.file(file).text()).toBe(before)
})

isolated("766 MCP names are own configuration keys rather than object prototype members", async () => {
  await Bun.write(file, '{"mcp":{"old":{"type":"local","command":["fixture"],"enabled":false}}}')
  const before = await Bun.file(file).text()
  expect(
    Exit.isFailure(
      await run(
        Effect.exit(
          ConfigCustomization.updateMCP("__proto__", { type: "local", command: ["synthetic"], disabled: true }),
        ),
      ),
    ),
  ).toBe(true)
  expect(Exit.isFailure(await run(Effect.exit(ConfigCustomization.toggleMCP("toString", false))))).toBe(true)
  expect(await Bun.file(file).text()).toBe(before)
})
