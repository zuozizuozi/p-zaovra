import { Command } from "@zaovra-ai/schema/command"
import { Location } from "@zaovra-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"
import { InvalidRequestError } from "../errors"

export const CommandGroup = HttpApiGroup.make("server.command")
  .add(
    HttpApiEndpoint.get("command.list", "/api/command", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Command.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.command.list",
          summary: "List commands",
          description: "Retrieve currently registered commands.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("command.render", "/api/command/render", {
      query: LocationQuery,
      payload: Schema.Struct({ name: Schema.String, arguments: Schema.String, agent: Schema.optional(Schema.String) }),
      success: Location.response(Schema.Struct({ template: Schema.String })),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "v2.command.render", summary: "Render one available skill or MCP prompt" }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "commands",
      description: "Experimental command routes.",
    }),
  )
