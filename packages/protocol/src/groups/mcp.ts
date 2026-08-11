import { Location } from "@zaovra-ai/schema/location"
import { Integration } from "@zaovra-ai/schema/integration"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const Status = Schema.Union([
  Schema.Struct({ status: Schema.Literal("connected"), tools: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("disabled") }),
  Schema.Struct({
    status: Schema.Literal("needs_auth"),
    error: Schema.String,
    integrationID: Integration.ID,
    methodID: Integration.MethodID,
  }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
]).pipe(Schema.toTaggedUnion("status"))

const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
})

export const MCPGroup = HttpApiGroup.make("server.mcp")
  .add(
    HttpApiEndpoint.get("mcp.status", "/api/mcp", {
      query: LocationQuery,
      success: Location.response(Schema.Record(Schema.String, Status)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.status",
          summary: "List MCP server status",
          description: "Retrieve the connection state of configured MCP servers.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("mcp.resources", "/api/mcp/resources", {
      query: LocationQuery,
      success: Location.response(Schema.Record(Schema.String, Resource)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.resources",
          summary: "List MCP resources",
          description: "Retrieve resources advertised by connected MCP servers.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("mcp.connect", "/api/mcp/:name/connect", {
      params: { name: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.connect",
          summary: "Connect MCP server",
          description: "Connect or retry one configured MCP server.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("mcp.disconnect", "/api/mcp/:name/disconnect", {
      params: { name: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.disconnect",
          summary: "Disconnect MCP server",
          description: "Disconnect one configured MCP server for this process.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "MCP", description: "MCP runtime connection routes." }))
