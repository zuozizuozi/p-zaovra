export * as CommandSources from "./command-sources"

import { Effect, Schema } from "effect"
import { Command } from "@zaovra-ai/schema/command"
import { AgentV2 } from "./agent"
import { CommandV2 } from "./command"
import { MCP } from "./mcp"
import { PermissionV2 } from "./permission"
import { SkillV2 } from "./skill"
import { SkillTool } from "./tool/skill"

export class Error extends Schema.TaggedErrorClass<Error>()("CommandSourceError", { message: Schema.String }) {}

export const skillName = (name: string) => `skill:${encodeURIComponent(name)}`
export const mcpName = (server: string, name: string) => `mcp:${encodeURIComponent(server)}:${encodeURIComponent(name)}`

export const list = Effect.fn("CommandSources.list")(function* () {
  const commands = yield* CommandV2.Service
  const skills = yield* SkillV2.Service
  const mcp = yield* MCP.Service
  const ordinary = yield* commands.list()
  const seen = new Set(ordinary.map((command) => command.name))
  const discovered: Command.Info[] = [
    ...(yield* skills.list())
      .filter((skill) => !skill.disabled && skill.slash !== false)
      .map((skill) => ({
        name: skillName(skill.name),
        template: "",
        description: skill.description ?? skill.name,
        source: "skill" as const,
      })),
    ...(yield* mcp.prompts()).map((prompt) => ({
      name: mcpName(prompt.server, prompt.name),
      template: "",
      description: prompt.description ?? `${prompt.server}: ${prompt.name}`,
      source: "mcp" as const,
      hints: (prompt.arguments ?? []).map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)),
    })),
  ]
  return [...ordinary, ...discovered.filter((command) => !seen.has(command.name))]
})

export const render = Effect.fn("CommandSources.render")(function* (name: string, args: string, agent?: string) {
  const skills = yield* SkillV2.Service
  const mcp = yield* MCP.Service
  const agents = yield* AgentV2.Service
  const selected = yield* agents.resolve(agent)
  const skill = (yield* skills.list()).find((skill) => skillName(skill.name) === name && skill.slash !== false)
  if (skill) {
    if (!selected || !SkillV2.available([skill], selected).length)
      return yield* new Error({ message: "This skill is disabled or unavailable to the selected agent." })
    return { template: [SkillTool.toModelOutput(skill, []), args.trim()].filter(Boolean).join("\n\n") }
  }
  const prompt = (yield* mcp.prompts()).find((prompt) => mcpName(prompt.server, prompt.name) === name)
  if (!prompt) return yield* new Error({ message: "This command is no longer available. Refresh Customization." })
  if (
    !selected ||
    PermissionV2.evaluate("read", `mcp:${prompt.server}:prompt:${prompt.name}`, selected.permissions).effect === "deny"
  )
    return yield* new Error({ message: "This MCP prompt is unavailable to the selected agent." })
  const parameters = prompt.arguments ?? []
  const values =
    parameters.length <= 1
      ? [args.trim()]
      : (args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((arg) => arg.replace(/^(['"])(.*)\1$/, "$2"))
  const missing = parameters.find((arg, index) => arg.required && !values[index])
  if (missing) return yield* new Error({ message: `The MCP prompt requires ${missing.name}.` })
  if (parameters.length > 1 && values.length > parameters.length)
    return yield* new Error({ message: "Too many MCP prompt arguments. Quote values that contain spaces." })
  const template = yield* mcp
    .renderPrompt(
      prompt.server,
      prompt.name,
      Object.fromEntries(parameters.flatMap((arg, index) => (values[index] ? [[arg.name, values[index]]] : []))),
    )
    .pipe(Effect.mapError((cause) => new Error({ message: cause.message })))
  return { template: parameters.length ? template : [template, args.trim()].filter(Boolean).join("\n\n") }
})
