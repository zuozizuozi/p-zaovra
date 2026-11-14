import { Memory } from "@zaovra-ai/schema/memory"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

// "project" is the project of the requested location; "user" follows the user across projects.
const Layer = Schema.Literals(["project", "user"])
const Query = Schema.Struct({ ...LocationQuery.fields, layer: Schema.optional(Layer) })

export const MemoryGroup = HttpApiGroup.make("server.memory")
  .add(
    HttpApiEndpoint.get("memory.list", "/api/memory", {
      query: Query,
      success: Schema.Struct({ data: Schema.Array(Memory.Note) }),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.list",
          summary: "List memory notes",
          description: "Retrieve the notes kept for a project, or the notes that follow the user across projects.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("memory.create", "/api/memory", {
      query: LocationQuery,
      payload: Schema.Struct({ layer: Schema.optional(Layer), kind: Memory.Kind, text: Schema.String }),
      success: Schema.Struct({ data: Schema.NullOr(Memory.Note) }),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.create",
          summary: "Add a memory note",
          description:
            "Add a note written by the user. Returns null when the same note was deleted before or the text is empty.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.patch("memory.update", "/api/memory/:id", {
      params: { id: Memory.ID },
      payload: Schema.Struct({
        text: Schema.optional(Schema.String),
        kind: Schema.optional(Memory.Kind),
        status: Schema.optional(Memory.Status),
      }),
      success: Schema.Struct({ data: Schema.NullOr(Memory.Note) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.update",
        summary: "Edit a memory note",
        description: "Change a note's text, kind or status. Returns null when the note does not exist.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("memory.remove", "/api/memory/:id", {
      params: { id: Memory.ID },
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.memory.remove",
        summary: "Delete a memory note",
        description: "Delete one note. The same fact is not recorded again.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("memory.clear", "/api/memory", {
      query: Query,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.clear",
          summary: "Clear memory notes",
          description: "Delete every note of a project, or every note that follows the user across projects.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "memory",
      description: "Notes kept from earlier conversations.",
    }),
  )
