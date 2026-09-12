import { Schema } from "effect"
import { optional } from "./schema"
import { statics } from "./schema"
import { Model } from "./model"

export const Selection = Schema.Struct({ agent: Schema.String, model: Model.Ref }).annotate({
  identifier: "Prompt.Selection",
})
export const Subtask = Schema.Struct({ command: Schema.String, agent: Schema.String, model: Model.Ref }).annotate({
  identifier: "Prompt.Subtask",
})

export interface Source extends Schema.Schema.Type<typeof Source> {}
export const Source = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
}).annotate({ identifier: "Prompt.Source" })

export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  source: Source.pipe(optional),
})
  .annotate({ identifier: "Prompt.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) =>
        schema.make({
          uri: input.uri,
          mime: input.mime,
          name: input.name,
          description: input.description,
          source: input.source,
        }),
    })),
  )

export interface AgentAttachment extends Schema.Schema.Type<typeof AgentAttachment> {}
export const AgentAttachment = Schema.Struct({
  name: Schema.String,
  source: Source.pipe(optional),
}).annotate({ identifier: "Prompt.AgentAttachment" })

export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}
export const Prompt = Schema.Struct({
  text: Schema.String,
  // Preserve the editable invocation while text contains the expanded model input.
  invocation: Schema.String.pipe(optional),
  files: Schema.Array(FileAttachment).pipe(optional),
  agents: Schema.Array(AgentAttachment).pipe(optional),
  selection: Selection.pipe(optional),
  subtask: Subtask.pipe(optional),
})
  .annotate({ identifier: "Prompt" })
  .pipe(
    statics((schema) => ({
      equivalence: Schema.toEquivalence(schema),
      fromUserMessage: (input: Pick<Prompt, "text" | "invocation" | "files" | "agents" | "selection" | "subtask">) =>
        schema.make({
          text: input.text,
          ...(input.invocation === undefined ? {} : { invocation: input.invocation }),
          ...(input.files === undefined ? {} : { files: input.files }),
          ...(input.agents === undefined ? {} : { agents: input.agents }),
          ...(input.selection === undefined ? {} : { selection: input.selection }),
          ...(input.subtask === undefined ? {} : { subtask: input.subtask }),
        }),
    })),
  )
