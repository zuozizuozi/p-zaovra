export * as Customization from "./customization"

import { Schema } from "effect"
import { AbsolutePath, optional } from "./schema"
import { MCPConfig } from "./mcp-config"

export const MCPEntry = MCPConfig.Server
export type MCPEntry = typeof MCPEntry.Type

export const Info = Schema.Struct({
  mcpEditable: Schema.Boolean,
  skillsEditable: Schema.Boolean,
  mcp: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.Literals(["local", "remote"]),
      disabled: Schema.Boolean,
      command: Schema.Array(Schema.String).pipe(optional),
      url: Schema.String.pipe(optional),
      status: Schema.Literals(["connected", "disabled", "needs_auth", "failed"]),
      error: Schema.String.pipe(optional),
      tools: Schema.Number.pipe(optional),
    }),
  ),
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String.pipe(optional),
      location: AbsolutePath,
      disabled: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: "Customization.Info" })

export class Error extends Schema.TaggedErrorClass<Error>()("CustomizationError", { message: Schema.String }) {}
