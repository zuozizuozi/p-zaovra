import { Customization } from "@zaovra-ai/schema/customization"
import { Location } from "@zaovra-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const CustomizationGroup = HttpApiGroup.make("server.customization")
  .add(
    HttpApiEndpoint.get("customization.list", "/api/customization", {
      query: LocationQuery,
      success: Location.response(Customization.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "v2.customization.list", summary: "List MCP servers and skills" }),
      ),
  )
  .add(
    HttpApiEndpoint.put("customization.saveMCP", "/api/customization/mcp/:name", {
      params: { name: Schema.String },
      query: LocationQuery,
      payload: Schema.Struct({ config: Customization.MCPEntry }),
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.customization.saveMCP", summary: "Save one MCP server" })),
  )
  .add(
    HttpApiEndpoint.delete("customization.removeMCP", "/api/customization/mcp/:name", {
      params: { name: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "v2.customization.removeMCP", summary: "Remove one MCP server" }),
      ),
  )
  .add(
    HttpApiEndpoint.put("customization.toggleMCP", "/api/customization/mcp/:name/enabled", {
      params: { name: Schema.String },
      query: LocationQuery,
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "v2.customization.toggleMCP", summary: "Persist MCP enabled state" }),
      ),
  )
  .add(
    HttpApiEndpoint.put("customization.toggleSkill", "/api/customization/skill/:name/enabled", {
      params: { name: Schema.String },
      query: LocationQuery,
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "v2.customization.toggleSkill", summary: "Persist skill enabled state" }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Customization",
      description: "Persistent MCP and skill management for the current location.",
    }),
  )
