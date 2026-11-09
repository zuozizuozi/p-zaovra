export * as ConfigCustomization from "./customization"

import path from "path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Effect, Option, Schema } from "effect"
import { Customization } from "@zaovra-ai/schema/customization"
import { Config } from "../config"
import { Global } from "../global"
import { FSUtil } from "../fs-util"
import { MCP } from "../mcp"
import { SkillV2 } from "../skill"
import { ConfigFile } from "./file"
import { ConfigMCP } from "./mcp"

export const list = Effect.fn("ConfigCustomization.list")(function* () {
  const config = yield* Config.Service
  const mcp = yield* MCP.Service
  const skills = yield* SkillV2.Service
  const entries = yield* config.entries()
  const servers = Config.latest(entries, "mcp")?.servers ?? {}
  const statuses = yield* mcp.status()
  yield* skills.reload()
  return {
    mcpEditable: editable(entries, "mcp"),
    skillsEditable: editable(entries, "disabled_skills"),
    mcp: Object.entries(servers).map(([name, server]) => ({
      name,
      type: server.type,
      disabled: server.disabled ?? false,
      ...(server.type === "local" ? { command: server.command } : { url: server.url }),
      ...(statuses[name] ?? { status: "disabled" as const }),
    })),
    skills: (yield* skills.list()).map((skill) => ({
      name: skill.name,
      description: skill.description,
      location: skill.location,
      disabled: skill.disabled ?? false,
    })),
  }
})

export const updateMCP = Effect.fn("ConfigCustomization.updateMCP")(function* (
  name: string,
  entry: Customization.MCPEntry | undefined,
) {
  if (!name.trim() || name.length > 128)
    return yield* new Customization.Error({ message: "Enter an MCP server name (1–128 characters)." })
  if (name === "__proto__") return yield* new Customization.Error({ message: "Choose a different MCP server name." })
  if (entry?.type === "local" && !entry.command[0]?.trim())
    return yield* new Customization.Error({ message: "Enter the MCP program to run." })
  if (
    entry?.type === "remote" &&
    (!URL.canParse(entry.url) || !["http:", "https:"].includes(new URL(entry.url).protocol))
  )
    return yield* new Customization.Error({ message: "Enter an HTTP or HTTPS MCP address." })
  return yield* update("mcp", (text, info, raw) => {
    if (entry && Object.hasOwn(info.mcp?.servers ?? {}, name))
      throw new Customization.Error({ message: "This MCP name already exists. Choose another name." })
    const native = Option.isSome(
      Schema.decodeUnknownOption(ConfigMCP.Info, { onExcessProperty: "error" })(raw.mcp ?? {}),
    )
    if (native) return edit(text, ["mcp", "servers", name], entry)
    // Upgrade only this legacy MCP field. Other configuration and comments stay untouched.
    const servers = entry ? { ...info.mcp?.servers, [name]: entry } : { ...info.mcp?.servers }
    if (!entry) delete servers[name]
    return edit(text, ["mcp"], { ...info.mcp, servers })
  })
})

export const toggleMCP = Effect.fn("ConfigCustomization.toggleMCP")(function* (name: string, enabled: boolean) {
  return yield* update("mcp", (text, info, raw) => {
    const servers = info.mcp?.servers
    const current = servers && Object.hasOwn(servers, name) ? servers[name] : undefined
    if (!current) throw new Customization.Error({ message: "This MCP server no longer exists. Refresh the list." })
    const entry = { ...current, disabled: !enabled }
    const native = Option.isSome(
      Schema.decodeUnknownOption(ConfigMCP.Info, { onExcessProperty: "error" })(raw.mcp ?? {}),
    )
    return native
      ? edit(text, ["mcp", "servers", name, "disabled"], !enabled)
      : edit(text, ["mcp"], { ...info.mcp, servers: { ...info.mcp?.servers, [name]: entry } })
  })
})

export const toggleSkill = Effect.fn("ConfigCustomization.toggleSkill")(function* (name: string, enabled: boolean) {
  const skills = yield* SkillV2.Service
  if (!(yield* skills.list()).some((skill) => skill.name === name))
    return yield* new Customization.Error({ message: "This skill no longer exists. Refresh the list." })
  return yield* update("disabled_skills", (text, info) =>
    edit(
      text,
      ["disabled_skills"],
      enabled
        ? (info.disabled_skills ?? []).filter((item) => item !== name)
        : [...new Set([...(info.disabled_skills ?? []), name])],
    ),
  )
})

function editable(entries: Config.Entry[], key: "mcp" | "disabled_skills") {
  const document = entries.findLast((entry) => entry.type === "document" && entry.info[key] !== undefined)
  return !document || (document.type === "document" && !!document.path)
}

const update = Effect.fn("ConfigCustomization.update")(function* (
  key: "mcp" | "disabled_skills",
  change: (text: string, info: Config.Info, raw: Record<string, unknown>) => string,
) {
  const config = yield* Config.Service
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const entries = yield* config.entries()
  if (!editable(entries, key))
    return yield* new Customization.Error({
      message: "This setting is supplied by the environment and cannot be saved here.",
    })
  const document = entries.findLast((entry) => entry.type === "document" && entry.info[key] !== undefined)
  const file =
    document?.type === "document" && document.path
      ? document.path
      : path.join(
          global.config,
          (yield* fs.existsSafe(path.join(global.config, "zaovra.jsonc")))
            ? "zaovra.jsonc"
            : (yield* fs.existsSafe(path.join(global.config, "zaovra.json")))
              ? "zaovra.json"
              : "zaovra.jsonc",
        )
  return yield* ConfigFile.update(fs, file, (before) =>
    Effect.try({
      try: () => {
        const text = before ?? "{}"
        const errors: ParseError[] = []
        const raw: unknown = parse(text, errors, { allowTrailingComma: true })
        const info = Option.getOrUndefined(Config.decode(raw))
        if (errors.length || !info || !raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Customization.Error({ message: "The configuration contains an error. Correct it before saving." })
        const next = change(text, info, raw as Record<string, unknown>)
        const valid = Option.isSome(Config.decode(parse(next)))
        if (!valid)
          throw new Customization.Error({ message: "The updated configuration is invalid. Nothing was saved." })
        return next
      },
      catch: (cause) =>
        cause instanceof Customization.Error
          ? cause
          : new Customization.Error({ message: "The configuration could not be updated." }),
    }),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof Customization.Error
        ? error
        : new Customization.Error({
            message:
              error instanceof ConfigFile.ConflictError
                ? error.message
                : "The configuration could not be saved. Reload and try again.",
          }),
    ),
  )
})

function edit(text: string, path: string[], value: unknown) {
  return applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
}
