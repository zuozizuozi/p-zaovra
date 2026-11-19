import { Memory } from "@zaovra-ai/schema/memory"
import { PositiveInt } from "@zaovra-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

// "project" is the project of the requested location; "user" follows the user across projects.
const Layer = Schema.Literals(["project", "user"])
const Query = Schema.Struct({ ...LocationQuery.fields, layer: Schema.optional(Layer) })

export class MemoryTidyError extends Schema.TaggedErrorClass<MemoryTidyError>()(
  "MemoryTidyError",
  {
    reason: Schema.Literals(["invalid", "conflict", "unauthorized", "limit", "duplicate", "missing", "busy", "count"]),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class MemoryPageError extends Schema.TaggedErrorClass<MemoryPageError>()(
  "MemoryPageError",
  {
    reason: Schema.Literals(["invalid", "source", "deleted", "conflict", "limit", "missing", "protected"]),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export const MemoryAutomaticGroup = HttpApiGroup.make("server.memoryAutomatic")
  .add(
    HttpApiEndpoint.get("memory.getAutomatic", "/api/memory/automatic", {
      query: LocationQuery,
      success: Schema.Struct({ data: Schema.NullOr(Memory.AutomaticPreference) }),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.getAutomatic",
          summary: "Read project automatic tidy consent without starting work",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.put("memory.confirmAutomatic", "/api/memory/automatic", {
      query: LocationQuery,
      payload: Memory.AutomaticConfirmation,
      success: Schema.Struct({ data: Memory.AutomaticPreference }),
      error: MemoryTidyError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.confirmAutomatic",
          summary: "Confirm automatic project tidy model and spending limits",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("memory.disableAutomatic", "/api/memory/automatic/disable", {
      query: LocationQuery,
      payload: Schema.Struct({ expected: Schema.String }),
      success: Schema.Struct({ data: Memory.AutomaticPreference }),
      error: MemoryTidyError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.disableAutomatic",
          summary: "Revoke automatic consent and stop its owned tidy task",
        }),
      ),
  )
export const MemoryGroup = HttpApiGroup.make("server.memory")
  .add(
    HttpApiEndpoint.get("memory.listPages", "/api/memory/pages", {
      query: Query,
      success: Schema.Struct({ data: Schema.Array(Memory.Page) }),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "v2.memory.listPages", summary: "Read topic pages and source freshness" }),
      ),
  )
  .add(
    HttpApiEndpoint.get("memory.getPage", "/api/memory/pages/:id", {
      params: { id: Memory.PageID },
      query: Query,
      success: Schema.Struct({ data: Schema.NullOr(Memory.Page) }),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "v2.memory.getPage", summary: "Read a topic page in the selected layer" }),
      ),
  )
  .add(
    HttpApiEndpoint.patch("memory.updatePage", "/api/memory/pages/:id", {
      params: { id: Memory.PageID },
      query: Query,
      payload: Schema.Struct({ summary: Schema.String, body: Schema.String, expected: Schema.String }),
      success: Schema.Struct({ data: Memory.Page }),
      error: MemoryPageError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.updatePage",
          summary: "Edit and protect a topic page from automatic rewriting",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("memory.removePage", "/api/memory/pages/:id", {
      params: { id: Memory.PageID },
      query: Query,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.removePage",
          summary: "Delete a topic page while retaining suppression hashes",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("memory.prepareTidy", "/api/memory/tidy", {
      query: LocationQuery,
      payload: Memory.TidyRequest,
      success: Schema.Struct({ data: Memory.TidyTask }),
      error: MemoryTidyError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.prepareTidy",
          summary: "Admit a confirmed memory task without starting model work",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("memory.listTidy", "/api/memory/tidy", {
      query: Query,
      success: Schema.Struct({ data: Schema.Array(Memory.TidyTask) }),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.listTidy",
          summary: "Read memory tasks and retained usage without resuming them",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("memory.getTidy", "/api/memory/tidy/:id", {
      params: { id: Schema.String },
      query: Query,
      success: Schema.Struct({ data: Memory.TidyTask }),
      error: MemoryTidyError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.getTidy",
          summary: "Read one memory task",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("memory.startTidy", "/api/memory/tidy/:id/start", {
      params: { id: Schema.String },
      query: Schema.Struct({
        ...Query.fields,
        checkpoint: Schema.optional(Schema.String),
        resumeTokens: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
      }),
      success: Schema.Struct({ data: Memory.TidyTask }),
      error: MemoryTidyError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.startTidy",
          summary: "Explicitly start or continue an admitted budgeted memory task",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("memory.cancelTidy", "/api/memory/tidy/:id/cancel", {
      params: { id: Schema.String },
      query: Query,
      success: Schema.Struct({ data: Memory.TidyTask }),
      error: MemoryTidyError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.cancelTidy",
          summary: "Revoke and stop a memory task while preserving uncertain charges",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("memory.recovery", "/api/memory/recovery", {
      query: LocationQuery,
      success: Schema.Struct({ data: Memory.Recovery }),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.recovery",
          summary: "View and export legacy memory for explicit recovery",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("memory.resolveRecovery", "/api/memory/recovery", {
      query: LocationQuery,
      payload: Memory.RecoveryChoice,
      success: Schema.Struct({ accepted: Schema.Boolean, data: Memory.Recovery }),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.resolveRecovery",
          summary: "Confirm selected legacy notes or start this directory blank",
        }),
      ),
  )
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
            "Add a note written by the user. Returns null while legacy recovery is pending, when deletion protection matches, or when the text is empty.",
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
        description:
          "Change a note's text, kind or status. Returns null when the note does not exist, is a read-only legacy original, or recovery/deletion protection blocks the change.",
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
