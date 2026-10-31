import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { ToolDefinition } from "@zaovra-ai/llm"
import { SessionMessage } from "../src/session/message"
import { ProviderV2 } from "../src/provider"
import { ModelV2 } from "../src/model"
import { ToolProfile } from "../src/session/tool-profile"
import { DeliveryContract } from "../src/session/delivery-contract"
const definitions = ["apply_patch", "bash", "bash_job", "browser", "edit", "evidence_read", "evidence_search", "glob", "grep", "read", "skill", "task", "tool_search", "verification_review", "webfetch", "websearch", "write", "custom_tool"].map((name) => new ToolDefinition({ name, description: name, inputSchema: { type: "object", properties: { retained: { type: "string" } } }, outputSchema: { type: "object" } }))
const names = (items: readonly ToolDefinition[]) => items.map((tool) => tool.name)
const user = (text: string) => SessionMessage.User.make({ id: SessionMessage.ID.make("msg_user"), type: "user", text, time: { created: DateTime.makeUnsafe(0) } })
const observed = (name: string, activated: string[] = [], status: "completed" | "error" = "completed") => SessionMessage.Assistant.make({ id: SessionMessage.ID.make("msg_tools"), type: "assistant", agent: "build", model: { providerID: ProviderV2.ID.make("offline"), id: ModelV2.ID.make("gpt-test") }, time: { created: DateTime.makeUnsafe(1) }, content: [{ type: "tool", name, id: "call_seen", time: { created: DateTime.makeUnsafe(1) }, state: status === "completed" ? { status, input: {}, content: [], structured: { activated } } : { status, input: {}, content: [{ type: "text", text: "Permission denied" }], structured: {}, error: { type: "unknown", message: "Permission denied" } } }] })
describe("model tool advertisements", () => {
  test("GPT prefers patch, defers expensive leaves and preserves complete input schemas", () => {
    const selected = ToolProfile.select(definitions, { model: "gpt-6-luna", history: [] })
    expect(names(selected)).toContain("apply_patch")
    expect(names(selected)).toContain("tool_search")
    expect(names(selected)).not.toContain("write")
    expect(names(selected)).not.toContain("edit")
    expect(names(selected)).not.toContain("browser")
    expect(names(selected)).toContain("custom_tool")
    expect(selected.every((tool) => definitions.includes(tool))).toBe(true)
    expect(JSON.stringify(selected).length).toBeLessThan(JSON.stringify(definitions).length)
  })
  test("non-GPT, aliases and explicit provider tool choices retain the original catalog", () => {
    for (const model of ["claude-opus", "qwen-coder", "custom-alias"])
      expect(ToolProfile.select(definitions, { model, history: [] })).toBe(definitions)
    expect(ToolProfile.select(definitions, { model: "gpt-6-luna", history: [], explicit: true })).toBe(definitions)
    const noSearch = definitions.filter((tool) => tool.name !== "tool_search")
    expect(ToolProfile.select(noSearch, { model: "gpt-6-luna", history: [] })).toBe(noSearch)
  })
  test("exact user requests, application overrides and allow rules remain advertised", () => {
    expect(names(ToolProfile.select(definitions, { model: "gpt-6-luna", history: [user("Use browser and write explicitly.")] }))).toEqual(expect.arrayContaining(["browser", "write"]))
    expect(names(ToolProfile.select(definitions, { model: "gpt-6-luna", history: [], custom: ["write"] }))).toContain("write")
    expect(names(ToolProfile.select(definitions, { model: "gpt-6-luna", history: [], permissions: [{ action: "edit", resource: "*", effect: "allow" }] }))).toEqual(expect.arrayContaining(["write", "edit", "apply_patch"]))
  })
  test("successful discovery survives serialized history, continuation and restart", () => {
    const history = [observed("tool_search", ["browser", "task", "webfetch"])]
    const replayed = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Message))(Schema.encodeSync(Schema.Array(SessionMessage.Message))(history))
    const first = ToolProfile.select(definitions, { model: "gpt-6-luna", history })
    const restarted = ToolProfile.select(definitions, { model: "gpt-6-luna", history: replayed })
    expect(names(first)).toEqual(expect.arrayContaining(["browser", "task", "webfetch"]))
    expect(names(restarted)).toEqual(names(first))
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(ToolProfile.select(definitions, { model: "gpt-6-luna", history: [] })))
  })
  test("failed discovery grants nothing; a failed explicit leaf remains available for repair", () => {
    const result = ToolProfile.select(definitions, { model: "gpt-6-luna", history: [observed("tool_search", ["browser"], "error"), observed("edit", [], "error")] })
    expect(names(result)).not.toContain("browser")
    expect(names(result)).toContain("edit")
  })
  test("repairTools remains the full upper bound, with no discovery bypass", () => {
    const repair = definitions.filter((tool) => DeliveryContract.repairTools.has(tool.name))
    expect(ToolProfile.select(repair, { model: "gpt-6-luna", history: [], repair: true })).toBe(repair)
    expect(names(repair)).toEqual(expect.arrayContaining(["write", "edit", "apply_patch", "evidence_read"]))
    expect(names(repair)).not.toContain("browser")
    expect(names(repair)).not.toContain("tool_search")
  })
  test("missing/denied patch does not hide the existing write paths or resurrect denied tools", () => {
    const allowed = definitions.filter((tool) => tool.name !== "apply_patch" && tool.name !== "browser")
    const selected = ToolProfile.select(allowed, { model: "gpt-6-luna", history: [observed("tool_search", ["browser"])] })
    expect(names(selected)).toEqual(expect.arrayContaining(["write", "edit"]))
    expect(names(selected)).not.toContain("browser")
  })
})

test("preserves an exact legacy write allow declaration as well as edit permission aliases", () => {
  expect(names(ToolProfile.select(definitions, { model: "gpt-6-luna", history: [], permissions: [{ action: "write", resource: "*", effect: "allow" }] }))).toContain("write")
})
