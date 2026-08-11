import type { ZaovraEventEncoded } from "@zaovra-ai/protocol/groups/event"

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type UnauthorizedError = { readonly _tag: "UnauthorizedError"; readonly message: string }
export const isUnauthorizedError = (value: unknown): value is UnauthorizedError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "UnauthorizedError"

export type InvalidRequestError = {
  readonly _tag: "InvalidRequestError"
  readonly message: string
  readonly kind?: string | undefined
  readonly field?: string | undefined
}
export const isInvalidRequestError = (value: unknown): value is InvalidRequestError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "InvalidRequestError"

export type InvalidCursorError = { readonly _tag: "InvalidCursorError"; readonly message: string }
export const isInvalidCursorError = (value: unknown): value is InvalidCursorError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "InvalidCursorError"

export type SessionNotFoundError = {
  readonly _tag: "SessionNotFoundError"
  readonly sessionID: string
  readonly message: string
}
export const isSessionNotFoundError = (value: unknown): value is SessionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "SessionNotFoundError"

export type ConflictError = {
  readonly _tag: "ConflictError"
  readonly message: string
  readonly resource?: string | undefined
}
export const isConflictError = (value: unknown): value is ConflictError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ConflictError"

export type ServiceUnavailableError = {
  readonly _tag: "ServiceUnavailableError"
  readonly message: string
  readonly service?: string | undefined
}
export const isServiceUnavailableError = (value: unknown): value is ServiceUnavailableError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ServiceUnavailableError"

export type MessageNotFoundError = {
  readonly _tag: "MessageNotFoundError"
  readonly sessionID: string
  readonly messageID: string
  readonly message: string
}
export const isMessageNotFoundError = (value: unknown): value is MessageNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "MessageNotFoundError"

export type UnknownError = {
  readonly _tag: "UnknownError"
  readonly message: string
  readonly ref?: string | undefined
}
export const isUnknownError = (value: unknown): value is UnknownError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "UnknownError"

export type WorkNotFoundError = {
  readonly _tag: "WorkNotFoundError"
  readonly goalID: string
  readonly message: string
}
export const isWorkNotFoundError = (value: unknown): value is WorkNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "WorkNotFoundError"

export type ProviderNotFoundError = {
  readonly _tag: "ProviderNotFoundError"
  readonly providerID: string
  readonly message: string
}
export const isProviderNotFoundError = (value: unknown): value is ProviderNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ProviderNotFoundError"

export type PermissionNotFoundError = {
  readonly _tag: "PermissionNotFoundError"
  readonly requestID: string
  readonly message: string
}
export const isPermissionNotFoundError = (value: unknown): value is PermissionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "PermissionNotFoundError"

export type PtyNotFoundError = { readonly _tag: "PtyNotFoundError"; readonly ptyID: string; readonly message: string }
export const isPtyNotFoundError = (value: unknown): value is PtyNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "PtyNotFoundError"

export type QuestionNotFoundError = {
  readonly _tag: "QuestionNotFoundError"
  readonly requestID: string
  readonly message: string
}
export const isQuestionNotFoundError = (value: unknown): value is QuestionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "QuestionNotFoundError"

export type ProjectCopyError = {
  readonly name: "ProjectCopyError"
  readonly data: { readonly message: string; readonly forceRequired?: boolean | undefined }
}
export const isProjectCopyError = (value: unknown): value is ProjectCopyError =>
  typeof value === "object" && value !== null && "name" in value && value["name"] === "ProjectCopyError"

export type HealthGetOutput = { readonly healthy: true }

export type LocationGetInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type LocationGetOutput = {
  readonly directory: string
  readonly workspaceID?: string
  readonly project: { readonly id: string; readonly directory: string }
}

export type AgentsListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentsListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }
    readonly system?: string
    readonly description?: string
    readonly mode: "subagent" | "primary" | "all"
    readonly hidden: boolean
    readonly color?: string | "primary" | "secondary" | "accent" | "success" | "warning" | "error" | "info"
    readonly steps?: number
    readonly permissions: ReadonlyArray<{
      readonly action: string
      readonly resource: string
      readonly effect: "allow" | "deny" | "ask"
    }>
  }>
}

export type SessionsListInput = {
  readonly workspace?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly roots?: boolean | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["workspace"]
  readonly limit?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly roots?: boolean | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["limit"]
  readonly order?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly roots?: boolean | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["order"]
  readonly search?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly roots?: boolean | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["search"]
  readonly roots?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly roots?: boolean | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["roots"]
  readonly directory?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly roots?: boolean | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["directory"]
  readonly project?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly roots?: boolean | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["project"]
  readonly subpath?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly roots?: boolean | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["subpath"]
  readonly cursor?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly roots?: boolean | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["cursor"]
}

export type SessionsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly parentID?: string
    readonly projectID: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
    readonly title: string
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly subpath?: string
    readonly revert?: {
      readonly messageID: string
      readonly partID?: string
      readonly snapshot?: string
      readonly diff?: string
      readonly files?: ReadonlyArray<{
        readonly path: string
        readonly status: "added" | "modified" | "deleted"
        readonly additions: number
        readonly deletions: number
        readonly patch: string
      }>
    }
  }>
  readonly cursor: { readonly previous?: string | null; readonly next?: string | null }
}

export type SessionsCreateInput = {
  readonly id?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
  }["id"]
  readonly agent?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
  }["agent"]
  readonly model?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
  }["model"]
  readonly location?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
  }["location"]
}

export type SessionsCreateOutput = {
  readonly data: {
    readonly id: string
    readonly parentID?: string
    readonly projectID: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
    readonly title: string
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly subpath?: string
    readonly revert?: {
      readonly messageID: string
      readonly partID?: string
      readonly snapshot?: string
      readonly diff?: string
      readonly files?: ReadonlyArray<{
        readonly path: string
        readonly status: "added" | "modified" | "deleted"
        readonly additions: number
        readonly deletions: number
        readonly patch: string
      }>
    }
  }
}["data"]

export type SessionsActiveOutput = { readonly data: { readonly [x: string]: { readonly type: "running" } } }["data"]

export type SessionsGetInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsGetOutput = {
  readonly data: {
    readonly id: string
    readonly parentID?: string
    readonly projectID: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
    readonly title: string
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly subpath?: string
    readonly revert?: {
      readonly messageID: string
      readonly partID?: string
      readonly snapshot?: string
      readonly diff?: string
      readonly files?: ReadonlyArray<{
        readonly path: string
        readonly status: "added" | "modified" | "deleted"
        readonly additions: number
        readonly deletions: number
        readonly patch: string
      }>
    }
  }
}["data"]

export type SessionsSwitchAgentInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly agent: { readonly agent: string }["agent"]
}

export type SessionsSwitchAgentOutput = void

export type SessionsSwitchModelInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly model: {
    readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
  }["model"]
}

export type SessionsSwitchModelOutput = void

export type SessionsPromptInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["id"]
  readonly prompt: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["prompt"]
  readonly delivery?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["delivery"]
  readonly resume?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["resume"]
}

export type SessionsPromptOutput = {
  readonly data: {
    readonly admittedSeq: number
    readonly id: string
    readonly sessionID: string
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery: "steer" | "queue"
    readonly timeCreated: number
    readonly promotedSeq?: number
  }
}["data"]

export type SessionsPendingInputsInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsPendingInputsOutput = {
  readonly data: ReadonlyArray<{
    readonly admittedSeq: number
    readonly id: string
    readonly sessionID: string
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery: "steer" | "queue"
    readonly timeCreated: number
    readonly promotedSeq?: number
  }>
}["data"]

export type SessionsShellInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | undefined
    readonly command: string
    readonly resume?: boolean | undefined
  }["id"]
  readonly command: {
    readonly id?: string | undefined
    readonly command: string
    readonly resume?: boolean | undefined
  }["command"]
  readonly resume?: {
    readonly id?: string | undefined
    readonly command: string
    readonly resume?: boolean | undefined
  }["resume"]
}

export type SessionsShellOutput = void

export type SessionsTodosInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsTodosOutput = {
  readonly data: ReadonlyArray<{ readonly content: string; readonly status: string; readonly priority: string }>
}["data"]

export type SessionsCompactInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsCompactOutput = { readonly data: { readonly compacted: boolean } }["data"]

export type SessionsWaitInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsWaitOutput = void

export type SessionsStageInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly messageID: { readonly messageID: string; readonly files?: boolean | undefined }["messageID"]
  readonly files?: { readonly messageID: string; readonly files?: boolean | undefined }["files"]
}

export type SessionsStageOutput = {
  readonly data: {
    readonly messageID: string
    readonly partID?: string
    readonly snapshot?: string
    readonly diff?: string
    readonly files?: ReadonlyArray<{
      readonly path: string
      readonly status: "added" | "modified" | "deleted"
      readonly additions: number
      readonly deletions: number
      readonly patch: string
    }>
  }
}["data"]

export type SessionsClearInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsClearOutput = void

export type SessionsCommitInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsCommitOutput = void

export type SessionsContextInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsContextOutput = {
  readonly data: ReadonlyArray<
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "agent-switched"
        readonly agent: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "model-switched"
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly text: string
        readonly files?: ReadonlyArray<{
          readonly uri: string
          readonly mime: string
          readonly name?: string
          readonly description?: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly agents?: ReadonlyArray<{
          readonly name: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly type: "user"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly sessionID: string
        readonly text: string
        readonly type: "synthetic"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "system"
        readonly text: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "shell"
        readonly callID: string
        readonly command: string
        readonly output: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "assistant"
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly inputSequence?: number
        readonly contextEpoch?: number
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly id: string; readonly text: string }
          | {
              readonly type: "reasoning"
              readonly id: string
              readonly text: string
              readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              readonly time?: { readonly created: number; readonly completed?: number }
            }
          | {
              readonly type: "tool"
              readonly id: string
              readonly name: string
              readonly provider?: {
                readonly executed: boolean
                readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
                readonly resultMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              }
              readonly state:
                | { readonly status: "pending"; readonly input: string }
                | {
                    readonly status: "running"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                  }
                | {
                    readonly status: "completed"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly attachments?: ReadonlyArray<{
                      readonly uri: string
                      readonly mime: string
                      readonly name?: string
                      readonly description?: string
                      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
                    }>
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly result?: JsonValue
                  }
                | {
                    readonly status: "error"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly error: { readonly type: "unknown"; readonly message: string }
                    readonly result?: JsonValue
                  }
              readonly time: {
                readonly created: number
                readonly ran?: number
                readonly completed?: number
                readonly pruned?: number
              }
            }
        >
        readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: ReadonlyArray<string> }
        readonly finish?: string
        readonly cost?: number
        readonly tokens?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly error?: { readonly type: "unknown"; readonly message: string }
      }
    | {
        readonly type: "compaction"
        readonly reason: "auto" | "manual"
        readonly summary: string
        readonly recent: string
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
      }
  >
}["data"]

export type SessionsHistoryInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: { readonly limit?: number | undefined; readonly after?: number | undefined }["limit"]
  readonly after?: { readonly limit?: number | undefined; readonly after?: number | undefined }["after"]
}

export type SessionsHistoryOutput = {
  readonly data: ReadonlyArray<
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.created"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly projectID: string
          readonly parentID?: string
          readonly agent?: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly location: { readonly directory: string; readonly workspaceID?: string }
          readonly subpath?: string
          readonly title: string
          readonly slug: string
          readonly version: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.agent.switched"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly agent: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.model.switched"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.moved"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly location: { readonly directory: string; readonly workspaceID?: string }
          readonly subdirectory?: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.updated"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly title?: string
          readonly archived?: boolean
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.deleted"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: { readonly timestamp: number; readonly sessionID: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.prompted"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly prompt: {
            readonly text: string
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly mime: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly agents?: ReadonlyArray<{
              readonly name: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
          }
          readonly delivery: "steer" | "queue"
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.prompt.admitted"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly prompt: {
            readonly text: string
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly mime: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly agents?: ReadonlyArray<{
              readonly name: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
          }
          readonly delivery: "steer" | "queue"
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.context.updated"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.synthetic"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.shell.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly callID: string
          readonly command: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.shell.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly callID: string
          readonly output: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.step.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly agent: string
          readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly inputSequence?: number
          readonly contextEpoch?: number
          readonly snapshot?: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.step.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly finish: string
          readonly cost: number
          readonly tokens: {
            readonly input: number
            readonly output: number
            readonly reasoning: number
            readonly cache: { readonly read: number; readonly write: number }
          }
          readonly snapshot?: string
          readonly files?: ReadonlyArray<string>
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.step.failed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly error: { readonly type: "unknown"; readonly message: string }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.text.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly textID: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.text.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly textID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.input.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly name: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.input.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.called"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly tool: string
          readonly input: { readonly [x: string]: JsonValue }
          readonly provider: {
            readonly executed: boolean
            readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.progress"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly structured: { readonly [x: string]: JsonValue }
          readonly content: ReadonlyArray<
            | { readonly type: "text"; readonly text: string }
            | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
          >
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.success"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly structured: { readonly [x: string]: JsonValue }
          readonly content: ReadonlyArray<
            | { readonly type: "text"; readonly text: string }
            | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
          >
          readonly outputPaths?: ReadonlyArray<string>
          readonly result?: JsonValue
          readonly provider: {
            readonly executed: boolean
            readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.failed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly error: { readonly type: "unknown"; readonly message: string }
          readonly result?: JsonValue
          readonly provider: {
            readonly executed: boolean
            readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.reasoning.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly reasoningID: string
          readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.reasoning.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly reasoningID: string
          readonly text: string
          readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.retried"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly attempt: number
          readonly error: {
            readonly message: string
            readonly statusCode?: number
            readonly isRetryable: boolean
            readonly responseHeaders?: { readonly [x: string]: string }
            readonly responseBody?: string
            readonly metadata?: { readonly [x: string]: string }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.compaction.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly reason: "auto" | "manual"
          readonly sourceSequence?: number
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.compaction.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly reason: "auto" | "manual"
          readonly sourceSequence?: number
          readonly text: string
          readonly recent: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.compaction.failed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly reason: "auto" | "manual"
          readonly sourceSequence: number
          readonly error: { readonly type: "unknown"; readonly message: string }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.revert.staged"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly revert: {
            readonly messageID: string
            readonly partID?: string
            readonly snapshot?: string
            readonly diff?: string
            readonly files?: ReadonlyArray<{
              readonly path: string
              readonly status: "added" | "modified" | "deleted"
              readonly additions: number
              readonly deletions: number
              readonly patch: string
            }>
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.revert.cleared"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: { readonly timestamp: number; readonly sessionID: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.revert.committed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: { readonly timestamp: number; readonly sessionID: string; readonly messageID: string }
      }
  >
  readonly hasMore: boolean
}

export type SessionsEventsInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly after?: { readonly after?: number | undefined }["after"]
}

export type SessionsEventsOutput =
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.created"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly projectID: string
        readonly parentID?: string
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly location: { readonly directory: string; readonly workspaceID?: string }
        readonly subpath?: string
        readonly title: string
        readonly slug: string
        readonly version: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.agent.switched"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly agent: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.model.switched"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.moved"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly location: { readonly directory: string; readonly workspaceID?: string }
        readonly subdirectory?: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.updated"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly title?: string
        readonly archived?: boolean
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.deleted"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: { readonly timestamp: number; readonly sessionID: string }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.prompted"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly prompt: {
          readonly text: string
          readonly files?: ReadonlyArray<{
            readonly uri: string
            readonly mime: string
            readonly name?: string
            readonly description?: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly agents?: ReadonlyArray<{
            readonly name: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
        }
        readonly delivery: "steer" | "queue"
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.prompt.admitted"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly prompt: {
          readonly text: string
          readonly files?: ReadonlyArray<{
            readonly uri: string
            readonly mime: string
            readonly name?: string
            readonly description?: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly agents?: ReadonlyArray<{
            readonly name: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
        }
        readonly delivery: "steer" | "queue"
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.context.updated"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.synthetic"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.shell.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly callID: string
        readonly command: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.shell.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly callID: string
        readonly output: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.step.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly inputSequence?: number
        readonly contextEpoch?: number
        readonly snapshot?: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.step.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly finish: string
        readonly cost: number
        readonly tokens: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly snapshot?: string
        readonly files?: ReadonlyArray<string>
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.step.failed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly error: { readonly type: "unknown"; readonly message: string }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.text.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly textID: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.text.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly textID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.input.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly name: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.input.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.called"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly tool: string
        readonly input: { readonly [x: string]: unknown }
        readonly provider: {
          readonly executed: boolean
          readonly metadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.progress"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly structured: { readonly [x: string]: unknown }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
        >
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.success"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly structured: { readonly [x: string]: unknown }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
        >
        readonly outputPaths?: ReadonlyArray<string>
        readonly result?: unknown
        readonly provider: {
          readonly executed: boolean
          readonly metadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.failed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly error: { readonly type: "unknown"; readonly message: string }
        readonly result?: unknown
        readonly provider: {
          readonly executed: boolean
          readonly metadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.reasoning.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly reasoningID: string
        readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.reasoning.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly reasoningID: string
        readonly text: string
        readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.retried"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly attempt: number
        readonly error: {
          readonly message: string
          readonly statusCode?: number
          readonly isRetryable: boolean
          readonly responseHeaders?: { readonly [x: string]: string }
          readonly responseBody?: string
          readonly metadata?: { readonly [x: string]: string }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.compaction.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly reason: "auto" | "manual"
        readonly sourceSequence?: number
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.compaction.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly reason: "auto" | "manual"
        readonly sourceSequence?: number
        readonly text: string
        readonly recent: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.compaction.failed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly reason: "auto" | "manual"
        readonly sourceSequence: number
        readonly error: { readonly type: "unknown"; readonly message: string }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.revert.staged"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly revert: {
          readonly messageID: string
          readonly partID?: string
          readonly snapshot?: string
          readonly diff?: string
          readonly files?: ReadonlyArray<{
            readonly path: string
            readonly status: "added" | "modified" | "deleted"
            readonly additions: number
            readonly deletions: number
            readonly patch: string
          }>
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.revert.cleared"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: { readonly timestamp: number; readonly sessionID: string }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.revert.committed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: { readonly timestamp: number; readonly sessionID: string; readonly messageID: string }
    }

export type SessionsInterruptInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsInterruptOutput = void

export type SessionsMessageInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string }["messageID"]
}

export type SessionsMessageOutput = {
  readonly data:
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "agent-switched"
        readonly agent: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "model-switched"
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly text: string
        readonly files?: ReadonlyArray<{
          readonly uri: string
          readonly mime: string
          readonly name?: string
          readonly description?: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly agents?: ReadonlyArray<{
          readonly name: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly type: "user"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly sessionID: string
        readonly text: string
        readonly type: "synthetic"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "system"
        readonly text: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "shell"
        readonly callID: string
        readonly command: string
        readonly output: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "assistant"
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly inputSequence?: number
        readonly contextEpoch?: number
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly id: string; readonly text: string }
          | {
              readonly type: "reasoning"
              readonly id: string
              readonly text: string
              readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              readonly time?: { readonly created: number; readonly completed?: number }
            }
          | {
              readonly type: "tool"
              readonly id: string
              readonly name: string
              readonly provider?: {
                readonly executed: boolean
                readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
                readonly resultMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              }
              readonly state:
                | { readonly status: "pending"; readonly input: string }
                | {
                    readonly status: "running"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                  }
                | {
                    readonly status: "completed"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly attachments?: ReadonlyArray<{
                      readonly uri: string
                      readonly mime: string
                      readonly name?: string
                      readonly description?: string
                      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
                    }>
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly result?: JsonValue
                  }
                | {
                    readonly status: "error"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly error: { readonly type: "unknown"; readonly message: string }
                    readonly result?: JsonValue
                  }
              readonly time: {
                readonly created: number
                readonly ran?: number
                readonly completed?: number
                readonly pruned?: number
              }
            }
        >
        readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: ReadonlyArray<string> }
        readonly finish?: string
        readonly cost?: number
        readonly tokens?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly error?: { readonly type: "unknown"; readonly message: string }
      }
    | {
        readonly type: "compaction"
        readonly reason: "auto" | "manual"
        readonly summary: string
        readonly recent: string
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
      }
}["data"]

export type SessionsUpdateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly title?: { readonly title?: string | undefined; readonly archived?: boolean | undefined }["title"]
  readonly archived?: { readonly title?: string | undefined; readonly archived?: boolean | undefined }["archived"]
}

export type SessionsUpdateOutput = {
  readonly data: {
    readonly id: string
    readonly parentID?: string
    readonly projectID: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
    readonly title: string
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly subpath?: string
    readonly revert?: {
      readonly messageID: string
      readonly partID?: string
      readonly snapshot?: string
      readonly diff?: string
      readonly files?: ReadonlyArray<{
        readonly path: string
        readonly status: "added" | "modified" | "deleted"
        readonly additions: number
        readonly deletions: number
        readonly patch: string
      }>
    }
  }
}["data"]

export type SessionsRemoveInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsRemoveOutput = void

export type WorkListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly objective: string
    readonly acceptanceCriteria: ReadonlyArray<{
      readonly id: string
      readonly description: string
      readonly required: boolean
      readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly verifier?:
        | {
            readonly type: "command"
            readonly command: string
            readonly timeoutMs?: number
            readonly successExitCodes?: ReadonlyArray<number>
          }
        | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
    }>
    readonly roleContracts?: ReadonlyArray<{
      readonly id: string
      readonly agentID: string
      readonly title: string
      readonly purpose: string
      readonly capabilities: ReadonlyArray<
        "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
      >
      readonly workspaceAccess: "read_only" | "write"
      readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
      readonly accepts: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
      readonly publishes: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
    }>
    readonly workerID?: string
    readonly status:
      | "draft"
      | "active"
      | "pausing"
      | "paused"
      | "cancelling"
      | "completed"
      | "blocked"
      | "cancelled"
      | "budget_exhausted"
    readonly budget?: {
      readonly maxAttemptsPerTask?: number
      readonly maxRepairAttempts?: number
      readonly maxParallelTasks?: number
      readonly maxReplans?: number
      readonly maxTurns?: number
      readonly maxDurationMs?: number
      readonly maxCost?: number
    }
    readonly usage: {
      readonly attempts: number
      readonly repairs: number
      readonly turns: number
      readonly cost: number
    }
    readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
    readonly revision: number
  }>
}["data"]

export type WorkCreateInput = {
  readonly id?: {
    readonly id?: string | null
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly objective: string
    readonly acceptanceCriteria: ReadonlyArray<{
      readonly id?: string | null
      readonly description: string
      readonly required: boolean
      readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly verifier?:
        | (
            | {
                readonly type: "command"
                readonly command: string
                readonly timeoutMs?: number
                readonly successExitCodes?: ReadonlyArray<number>
              }
            | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
          )
        | null
    }>
    readonly budget?: {
      readonly maxAttemptsPerTask?: number
      readonly maxRepairAttempts?: number
      readonly maxParallelTasks?: number
      readonly maxReplans?: number
      readonly maxTurns?: number
      readonly maxDurationMs?: number
      readonly maxCost?: number
    } | null
    readonly planning?: boolean | null
    readonly tasks?: ReadonlyArray<{
      readonly id?: string | null
      readonly title: string
      readonly instructions: string
      readonly dependsOn?: ReadonlyArray<string> | null
      readonly role?: string | null
      readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
      readonly criteria?: ReadonlyArray<string> | null
    }> | null
  }["id"]
  readonly location: {
    readonly id?: string | null
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly objective: string
    readonly acceptanceCriteria: ReadonlyArray<{
      readonly id?: string | null
      readonly description: string
      readonly required: boolean
      readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly verifier?:
        | (
            | {
                readonly type: "command"
                readonly command: string
                readonly timeoutMs?: number
                readonly successExitCodes?: ReadonlyArray<number>
              }
            | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
          )
        | null
    }>
    readonly budget?: {
      readonly maxAttemptsPerTask?: number
      readonly maxRepairAttempts?: number
      readonly maxParallelTasks?: number
      readonly maxReplans?: number
      readonly maxTurns?: number
      readonly maxDurationMs?: number
      readonly maxCost?: number
    } | null
    readonly planning?: boolean | null
    readonly tasks?: ReadonlyArray<{
      readonly id?: string | null
      readonly title: string
      readonly instructions: string
      readonly dependsOn?: ReadonlyArray<string> | null
      readonly role?: string | null
      readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
      readonly criteria?: ReadonlyArray<string> | null
    }> | null
  }["location"]
  readonly objective: {
    readonly id?: string | null
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly objective: string
    readonly acceptanceCriteria: ReadonlyArray<{
      readonly id?: string | null
      readonly description: string
      readonly required: boolean
      readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly verifier?:
        | (
            | {
                readonly type: "command"
                readonly command: string
                readonly timeoutMs?: number
                readonly successExitCodes?: ReadonlyArray<number>
              }
            | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
          )
        | null
    }>
    readonly budget?: {
      readonly maxAttemptsPerTask?: number
      readonly maxRepairAttempts?: number
      readonly maxParallelTasks?: number
      readonly maxReplans?: number
      readonly maxTurns?: number
      readonly maxDurationMs?: number
      readonly maxCost?: number
    } | null
    readonly planning?: boolean | null
    readonly tasks?: ReadonlyArray<{
      readonly id?: string | null
      readonly title: string
      readonly instructions: string
      readonly dependsOn?: ReadonlyArray<string> | null
      readonly role?: string | null
      readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
      readonly criteria?: ReadonlyArray<string> | null
    }> | null
  }["objective"]
  readonly acceptanceCriteria: {
    readonly id?: string | null
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly objective: string
    readonly acceptanceCriteria: ReadonlyArray<{
      readonly id?: string | null
      readonly description: string
      readonly required: boolean
      readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly verifier?:
        | (
            | {
                readonly type: "command"
                readonly command: string
                readonly timeoutMs?: number
                readonly successExitCodes?: ReadonlyArray<number>
              }
            | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
          )
        | null
    }>
    readonly budget?: {
      readonly maxAttemptsPerTask?: number
      readonly maxRepairAttempts?: number
      readonly maxParallelTasks?: number
      readonly maxReplans?: number
      readonly maxTurns?: number
      readonly maxDurationMs?: number
      readonly maxCost?: number
    } | null
    readonly planning?: boolean | null
    readonly tasks?: ReadonlyArray<{
      readonly id?: string | null
      readonly title: string
      readonly instructions: string
      readonly dependsOn?: ReadonlyArray<string> | null
      readonly role?: string | null
      readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
      readonly criteria?: ReadonlyArray<string> | null
    }> | null
  }["acceptanceCriteria"]
  readonly budget?: {
    readonly id?: string | null
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly objective: string
    readonly acceptanceCriteria: ReadonlyArray<{
      readonly id?: string | null
      readonly description: string
      readonly required: boolean
      readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly verifier?:
        | (
            | {
                readonly type: "command"
                readonly command: string
                readonly timeoutMs?: number
                readonly successExitCodes?: ReadonlyArray<number>
              }
            | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
          )
        | null
    }>
    readonly budget?: {
      readonly maxAttemptsPerTask?: number
      readonly maxRepairAttempts?: number
      readonly maxParallelTasks?: number
      readonly maxReplans?: number
      readonly maxTurns?: number
      readonly maxDurationMs?: number
      readonly maxCost?: number
    } | null
    readonly planning?: boolean | null
    readonly tasks?: ReadonlyArray<{
      readonly id?: string | null
      readonly title: string
      readonly instructions: string
      readonly dependsOn?: ReadonlyArray<string> | null
      readonly role?: string | null
      readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
      readonly criteria?: ReadonlyArray<string> | null
    }> | null
  }["budget"]
  readonly planning?: {
    readonly id?: string | null
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly objective: string
    readonly acceptanceCriteria: ReadonlyArray<{
      readonly id?: string | null
      readonly description: string
      readonly required: boolean
      readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly verifier?:
        | (
            | {
                readonly type: "command"
                readonly command: string
                readonly timeoutMs?: number
                readonly successExitCodes?: ReadonlyArray<number>
              }
            | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
          )
        | null
    }>
    readonly budget?: {
      readonly maxAttemptsPerTask?: number
      readonly maxRepairAttempts?: number
      readonly maxParallelTasks?: number
      readonly maxReplans?: number
      readonly maxTurns?: number
      readonly maxDurationMs?: number
      readonly maxCost?: number
    } | null
    readonly planning?: boolean | null
    readonly tasks?: ReadonlyArray<{
      readonly id?: string | null
      readonly title: string
      readonly instructions: string
      readonly dependsOn?: ReadonlyArray<string> | null
      readonly role?: string | null
      readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
      readonly criteria?: ReadonlyArray<string> | null
    }> | null
  }["planning"]
  readonly tasks?: {
    readonly id?: string | null
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly objective: string
    readonly acceptanceCriteria: ReadonlyArray<{
      readonly id?: string | null
      readonly description: string
      readonly required: boolean
      readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly verifier?:
        | (
            | {
                readonly type: "command"
                readonly command: string
                readonly timeoutMs?: number
                readonly successExitCodes?: ReadonlyArray<number>
              }
            | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
          )
        | null
    }>
    readonly budget?: {
      readonly maxAttemptsPerTask?: number
      readonly maxRepairAttempts?: number
      readonly maxParallelTasks?: number
      readonly maxReplans?: number
      readonly maxTurns?: number
      readonly maxDurationMs?: number
      readonly maxCost?: number
    } | null
    readonly planning?: boolean | null
    readonly tasks?: ReadonlyArray<{
      readonly id?: string | null
      readonly title: string
      readonly instructions: string
      readonly dependsOn?: ReadonlyArray<string> | null
      readonly role?: string | null
      readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
      readonly criteria?: ReadonlyArray<string> | null
    }> | null
  }["tasks"]
}

export type WorkCreateOutput = {
  readonly data: {
    readonly goal: {
      readonly id: string
      readonly location: { readonly directory: string; readonly workspaceID?: string }
      readonly objective: string
      readonly acceptanceCriteria: ReadonlyArray<{
        readonly id: string
        readonly description: string
        readonly required: boolean
        readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
        readonly verifier?:
          | {
              readonly type: "command"
              readonly command: string
              readonly timeoutMs?: number
              readonly successExitCodes?: ReadonlyArray<number>
            }
          | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
      }>
      readonly roleContracts?: ReadonlyArray<{
        readonly id: string
        readonly agentID: string
        readonly title: string
        readonly purpose: string
        readonly capabilities: ReadonlyArray<
          "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
        >
        readonly workspaceAccess: "read_only" | "write"
        readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
        readonly accepts: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
        readonly publishes: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
      }>
      readonly workerID?: string
      readonly status:
        | "draft"
        | "active"
        | "pausing"
        | "paused"
        | "cancelling"
        | "completed"
        | "blocked"
        | "cancelled"
        | "budget_exhausted"
      readonly budget?: {
        readonly maxAttemptsPerTask?: number
        readonly maxRepairAttempts?: number
        readonly maxParallelTasks?: number
        readonly maxReplans?: number
        readonly maxTurns?: number
        readonly maxDurationMs?: number
        readonly maxCost?: number
      }
      readonly usage: {
        readonly attempts: number
        readonly repairs: number
        readonly turns: number
        readonly cost: number
      }
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }
    readonly tasks: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly title: string
      readonly instructions: string
      readonly dependsOn: ReadonlyArray<string>
      readonly role: string
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly status:
        | "pending"
        | "ready"
        | "running"
        | "verifying"
        | "reviewing"
        | "merging"
        | "rework"
        | "completed"
        | "superseded"
        | "blocked"
        | "cancelled"
      readonly criteria: ReadonlyArray<string>
      readonly attemptCount: number
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }>
    readonly attempts: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly kind: "plan" | "replan" | "execute" | "repair" | "verify" | "review"
      readonly number: number
      readonly sessionID?: string
      readonly status: "admitted" | "running" | "succeeded" | "failed" | "interrupted" | "unknown" | "cancelled"
      readonly ownerID?: string
      readonly fence?: number
      readonly inputRevision: number
      readonly failure?: {
        readonly kind: "error" | "interrupted" | "unknown" | "cancelled" | "permission" | "budget"
        readonly message: string
        readonly retryable: boolean
        readonly details?: JsonValue
      }
      readonly time: { readonly created: number; readonly started?: number; readonly ended?: number }
    }>
    readonly evidence: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionIDs: ReadonlyArray<string>
      readonly kind: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly producer: string
      readonly payload: JsonValue
      readonly digest?: string
      readonly reference?: string
      readonly createdAt: number
    }>
    readonly evaluations: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionID: string
      readonly evidenceIDs: ReadonlyArray<string>
      readonly verdict: "pass" | "fail" | "blocked"
      readonly evaluator: string
      readonly evaluatorVersion: string
      readonly findings: ReadonlyArray<{
        readonly code?: string
        readonly message: string
        readonly severity: "info" | "warning" | "error"
        readonly location?: string
      }>
      readonly allowsRepair: boolean
      readonly createdAt: number
    }>
    readonly handoffs: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly producer: string
      readonly summary: string
      readonly items: ReadonlyArray<{
        readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        readonly text: string
        readonly reference?: string
        readonly memory?: "task" | "project"
        readonly key?: string
        readonly expiresAt?: number
      }>
      readonly evidenceIDs: ReadonlyArray<string>
      readonly recipients: ReadonlyArray<string>
      readonly digest: string
      readonly createdAt: number
    }>
    readonly roles: ReadonlyArray<{
      readonly id: string
      readonly agentID: string
      readonly title: string
      readonly purpose: string
      readonly capabilities: ReadonlyArray<
        "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
      >
      readonly workspaceAccess: "read_only" | "write"
      readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
      readonly accepts: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
      readonly publishes: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
    }>
    readonly memory: {
      readonly entries: ReadonlyArray<{
        readonly key: string
        readonly status: "current" | "conflicted" | "resolved"
        readonly candidates: ReadonlyArray<{
          readonly handoffID: string
          readonly goalID: string
          readonly taskID: string
          readonly producer: string
          readonly item: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly itemDigest: string
          readonly evidenceIDs: ReadonlyArray<string>
          readonly digest: string
          readonly createdAt: number
        }>
        readonly resolution?: {
          readonly id: string
          readonly goalID: string
          readonly location: { readonly directory: string; readonly workspaceID?: string }
          readonly key: string
          readonly handoffID: string
          readonly handoffDigest: string
          readonly itemDigest: string
          readonly action: "select" | "replace" | "delete"
          readonly value?: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly resolver: string
          readonly reason?: string
          readonly createdAt: number
        }
      }>
      readonly resolutions: ReadonlyArray<{
        readonly id: string
        readonly goalID: string
        readonly location: { readonly directory: string; readonly workspaceID?: string }
        readonly key: string
        readonly handoffID: string
        readonly handoffDigest: string
        readonly itemDigest: string
        readonly action: "select" | "replace" | "delete"
        readonly value?: {
          readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
          readonly text: string
          readonly reference?: string
          readonly memory?: "task" | "project"
          readonly key?: string
          readonly expiresAt?: number
        }
        readonly resolver: string
        readonly reason?: string
        readonly createdAt: number
      }>
    }
  }
}["data"]

export type WorkActiveOutput = { readonly data: { readonly [x: string]: { readonly type: "running" } } }["data"]

export type WorkArtifactsOutput = {
  readonly data: ReadonlyArray<{
    readonly artifact: {
      readonly digest: string
      readonly reference: string
      readonly size: number
      readonly mediaType: "text/x-diff"
    }
    readonly referenceCount: number
    readonly state: "active" | "collected"
    readonly createdAt: number
    readonly accessedAt: number
    readonly collectedAt?: number
  }>
}["data"]

export type WorkArtifactCollectInput = {
  readonly minimumAgeMs: {
    readonly minimumAgeMs: number
    readonly dryRun: boolean
    readonly limit?: number | undefined
  }["minimumAgeMs"]
  readonly dryRun: {
    readonly minimumAgeMs: number
    readonly dryRun: boolean
    readonly limit?: number | undefined
  }["dryRun"]
  readonly limit?: {
    readonly minimumAgeMs: number
    readonly dryRun: boolean
    readonly limit?: number | undefined
  }["limit"]
}

export type WorkArtifactCollectOutput = {
  readonly data: {
    readonly dryRun: boolean
    readonly scanned: number
    readonly collected: number
    readonly reclaimedBytes: number
    readonly artifacts: ReadonlyArray<{
      readonly digest: string
      readonly reference: string
      readonly size: number
      readonly mediaType: "text/x-diff"
    }>
  }
}["data"]

export type WorkGetInput = { readonly goalID: { readonly goalID: string }["goalID"] }

export type WorkGetOutput = {
  readonly data: {
    readonly goal: {
      readonly id: string
      readonly location: { readonly directory: string; readonly workspaceID?: string }
      readonly objective: string
      readonly acceptanceCriteria: ReadonlyArray<{
        readonly id: string
        readonly description: string
        readonly required: boolean
        readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
        readonly verifier?:
          | {
              readonly type: "command"
              readonly command: string
              readonly timeoutMs?: number
              readonly successExitCodes?: ReadonlyArray<number>
            }
          | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
      }>
      readonly roleContracts?: ReadonlyArray<{
        readonly id: string
        readonly agentID: string
        readonly title: string
        readonly purpose: string
        readonly capabilities: ReadonlyArray<
          "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
        >
        readonly workspaceAccess: "read_only" | "write"
        readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
        readonly accepts: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
        readonly publishes: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
      }>
      readonly workerID?: string
      readonly status:
        | "draft"
        | "active"
        | "pausing"
        | "paused"
        | "cancelling"
        | "completed"
        | "blocked"
        | "cancelled"
        | "budget_exhausted"
      readonly budget?: {
        readonly maxAttemptsPerTask?: number
        readonly maxRepairAttempts?: number
        readonly maxParallelTasks?: number
        readonly maxReplans?: number
        readonly maxTurns?: number
        readonly maxDurationMs?: number
        readonly maxCost?: number
      }
      readonly usage: {
        readonly attempts: number
        readonly repairs: number
        readonly turns: number
        readonly cost: number
      }
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }
    readonly tasks: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly title: string
      readonly instructions: string
      readonly dependsOn: ReadonlyArray<string>
      readonly role: string
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly status:
        | "pending"
        | "ready"
        | "running"
        | "verifying"
        | "reviewing"
        | "merging"
        | "rework"
        | "completed"
        | "superseded"
        | "blocked"
        | "cancelled"
      readonly criteria: ReadonlyArray<string>
      readonly attemptCount: number
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }>
    readonly attempts: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly kind: "plan" | "replan" | "execute" | "repair" | "verify" | "review"
      readonly number: number
      readonly sessionID?: string
      readonly status: "admitted" | "running" | "succeeded" | "failed" | "interrupted" | "unknown" | "cancelled"
      readonly ownerID?: string
      readonly fence?: number
      readonly inputRevision: number
      readonly failure?: {
        readonly kind: "error" | "interrupted" | "unknown" | "cancelled" | "permission" | "budget"
        readonly message: string
        readonly retryable: boolean
        readonly details?: JsonValue
      }
      readonly time: { readonly created: number; readonly started?: number; readonly ended?: number }
    }>
    readonly evidence: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionIDs: ReadonlyArray<string>
      readonly kind: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly producer: string
      readonly payload: JsonValue
      readonly digest?: string
      readonly reference?: string
      readonly createdAt: number
    }>
    readonly evaluations: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionID: string
      readonly evidenceIDs: ReadonlyArray<string>
      readonly verdict: "pass" | "fail" | "blocked"
      readonly evaluator: string
      readonly evaluatorVersion: string
      readonly findings: ReadonlyArray<{
        readonly code?: string
        readonly message: string
        readonly severity: "info" | "warning" | "error"
        readonly location?: string
      }>
      readonly allowsRepair: boolean
      readonly createdAt: number
    }>
    readonly handoffs: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly producer: string
      readonly summary: string
      readonly items: ReadonlyArray<{
        readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        readonly text: string
        readonly reference?: string
        readonly memory?: "task" | "project"
        readonly key?: string
        readonly expiresAt?: number
      }>
      readonly evidenceIDs: ReadonlyArray<string>
      readonly recipients: ReadonlyArray<string>
      readonly digest: string
      readonly createdAt: number
    }>
    readonly roles: ReadonlyArray<{
      readonly id: string
      readonly agentID: string
      readonly title: string
      readonly purpose: string
      readonly capabilities: ReadonlyArray<
        "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
      >
      readonly workspaceAccess: "read_only" | "write"
      readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
      readonly accepts: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
      readonly publishes: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
    }>
    readonly memory: {
      readonly entries: ReadonlyArray<{
        readonly key: string
        readonly status: "current" | "conflicted" | "resolved"
        readonly candidates: ReadonlyArray<{
          readonly handoffID: string
          readonly goalID: string
          readonly taskID: string
          readonly producer: string
          readonly item: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly itemDigest: string
          readonly evidenceIDs: ReadonlyArray<string>
          readonly digest: string
          readonly createdAt: number
        }>
        readonly resolution?: {
          readonly id: string
          readonly goalID: string
          readonly location: { readonly directory: string; readonly workspaceID?: string }
          readonly key: string
          readonly handoffID: string
          readonly handoffDigest: string
          readonly itemDigest: string
          readonly action: "select" | "replace" | "delete"
          readonly value?: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly resolver: string
          readonly reason?: string
          readonly createdAt: number
        }
      }>
      readonly resolutions: ReadonlyArray<{
        readonly id: string
        readonly goalID: string
        readonly location: { readonly directory: string; readonly workspaceID?: string }
        readonly key: string
        readonly handoffID: string
        readonly handoffDigest: string
        readonly itemDigest: string
        readonly action: "select" | "replace" | "delete"
        readonly value?: {
          readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
          readonly text: string
          readonly reference?: string
          readonly memory?: "task" | "project"
          readonly key?: string
          readonly expiresAt?: number
        }
        readonly resolver: string
        readonly reason?: string
        readonly createdAt: number
      }>
    }
  }
}["data"]

export type WorkExpandInput = {
  readonly goalID: { readonly goalID: string }["goalID"]
  readonly tasks: {
    readonly tasks: ReadonlyArray<{
      readonly id: string
      readonly title: string
      readonly instructions: string
      readonly dependsOn?: ReadonlyArray<string> | null
      readonly role?: string | null
      readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
      readonly criteria?: ReadonlyArray<string> | null
    }>
  }["tasks"]
}

export type WorkExpandOutput = {
  readonly data: {
    readonly goal: {
      readonly id: string
      readonly location: { readonly directory: string; readonly workspaceID?: string }
      readonly objective: string
      readonly acceptanceCriteria: ReadonlyArray<{
        readonly id: string
        readonly description: string
        readonly required: boolean
        readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
        readonly verifier?:
          | {
              readonly type: "command"
              readonly command: string
              readonly timeoutMs?: number
              readonly successExitCodes?: ReadonlyArray<number>
            }
          | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
      }>
      readonly roleContracts?: ReadonlyArray<{
        readonly id: string
        readonly agentID: string
        readonly title: string
        readonly purpose: string
        readonly capabilities: ReadonlyArray<
          "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
        >
        readonly workspaceAccess: "read_only" | "write"
        readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
        readonly accepts: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
        readonly publishes: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
      }>
      readonly workerID?: string
      readonly status:
        | "draft"
        | "active"
        | "pausing"
        | "paused"
        | "cancelling"
        | "completed"
        | "blocked"
        | "cancelled"
        | "budget_exhausted"
      readonly budget?: {
        readonly maxAttemptsPerTask?: number
        readonly maxRepairAttempts?: number
        readonly maxParallelTasks?: number
        readonly maxReplans?: number
        readonly maxTurns?: number
        readonly maxDurationMs?: number
        readonly maxCost?: number
      }
      readonly usage: {
        readonly attempts: number
        readonly repairs: number
        readonly turns: number
        readonly cost: number
      }
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }
    readonly tasks: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly title: string
      readonly instructions: string
      readonly dependsOn: ReadonlyArray<string>
      readonly role: string
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly status:
        | "pending"
        | "ready"
        | "running"
        | "verifying"
        | "reviewing"
        | "merging"
        | "rework"
        | "completed"
        | "superseded"
        | "blocked"
        | "cancelled"
      readonly criteria: ReadonlyArray<string>
      readonly attemptCount: number
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }>
    readonly attempts: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly kind: "plan" | "replan" | "execute" | "repair" | "verify" | "review"
      readonly number: number
      readonly sessionID?: string
      readonly status: "admitted" | "running" | "succeeded" | "failed" | "interrupted" | "unknown" | "cancelled"
      readonly ownerID?: string
      readonly fence?: number
      readonly inputRevision: number
      readonly failure?: {
        readonly kind: "error" | "interrupted" | "unknown" | "cancelled" | "permission" | "budget"
        readonly message: string
        readonly retryable: boolean
        readonly details?: JsonValue
      }
      readonly time: { readonly created: number; readonly started?: number; readonly ended?: number }
    }>
    readonly evidence: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionIDs: ReadonlyArray<string>
      readonly kind: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly producer: string
      readonly payload: JsonValue
      readonly digest?: string
      readonly reference?: string
      readonly createdAt: number
    }>
    readonly evaluations: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionID: string
      readonly evidenceIDs: ReadonlyArray<string>
      readonly verdict: "pass" | "fail" | "blocked"
      readonly evaluator: string
      readonly evaluatorVersion: string
      readonly findings: ReadonlyArray<{
        readonly code?: string
        readonly message: string
        readonly severity: "info" | "warning" | "error"
        readonly location?: string
      }>
      readonly allowsRepair: boolean
      readonly createdAt: number
    }>
    readonly handoffs: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly producer: string
      readonly summary: string
      readonly items: ReadonlyArray<{
        readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        readonly text: string
        readonly reference?: string
        readonly memory?: "task" | "project"
        readonly key?: string
        readonly expiresAt?: number
      }>
      readonly evidenceIDs: ReadonlyArray<string>
      readonly recipients: ReadonlyArray<string>
      readonly digest: string
      readonly createdAt: number
    }>
    readonly roles: ReadonlyArray<{
      readonly id: string
      readonly agentID: string
      readonly title: string
      readonly purpose: string
      readonly capabilities: ReadonlyArray<
        "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
      >
      readonly workspaceAccess: "read_only" | "write"
      readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
      readonly accepts: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
      readonly publishes: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
    }>
    readonly memory: {
      readonly entries: ReadonlyArray<{
        readonly key: string
        readonly status: "current" | "conflicted" | "resolved"
        readonly candidates: ReadonlyArray<{
          readonly handoffID: string
          readonly goalID: string
          readonly taskID: string
          readonly producer: string
          readonly item: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly itemDigest: string
          readonly evidenceIDs: ReadonlyArray<string>
          readonly digest: string
          readonly createdAt: number
        }>
        readonly resolution?: {
          readonly id: string
          readonly goalID: string
          readonly location: { readonly directory: string; readonly workspaceID?: string }
          readonly key: string
          readonly handoffID: string
          readonly handoffDigest: string
          readonly itemDigest: string
          readonly action: "select" | "replace" | "delete"
          readonly value?: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly resolver: string
          readonly reason?: string
          readonly createdAt: number
        }
      }>
      readonly resolutions: ReadonlyArray<{
        readonly id: string
        readonly goalID: string
        readonly location: { readonly directory: string; readonly workspaceID?: string }
        readonly key: string
        readonly handoffID: string
        readonly handoffDigest: string
        readonly itemDigest: string
        readonly action: "select" | "replace" | "delete"
        readonly value?: {
          readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
          readonly text: string
          readonly reference?: string
          readonly memory?: "task" | "project"
          readonly key?: string
          readonly expiresAt?: number
        }
        readonly resolver: string
        readonly reason?: string
        readonly createdAt: number
      }>
    }
  }
}["data"]

export type WorkReplanInput = {
  readonly goalID: { readonly goalID: string }["goalID"]
  readonly taskID: { readonly taskID: string; readonly reason: string }["taskID"]
  readonly reason: { readonly taskID: string; readonly reason: string }["reason"]
}

export type WorkReplanOutput = {
  readonly data: {
    readonly goal: {
      readonly id: string
      readonly location: { readonly directory: string; readonly workspaceID?: string }
      readonly objective: string
      readonly acceptanceCriteria: ReadonlyArray<{
        readonly id: string
        readonly description: string
        readonly required: boolean
        readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
        readonly verifier?:
          | {
              readonly type: "command"
              readonly command: string
              readonly timeoutMs?: number
              readonly successExitCodes?: ReadonlyArray<number>
            }
          | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
      }>
      readonly roleContracts?: ReadonlyArray<{
        readonly id: string
        readonly agentID: string
        readonly title: string
        readonly purpose: string
        readonly capabilities: ReadonlyArray<
          "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
        >
        readonly workspaceAccess: "read_only" | "write"
        readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
        readonly accepts: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
        readonly publishes: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
      }>
      readonly workerID?: string
      readonly status:
        | "draft"
        | "active"
        | "pausing"
        | "paused"
        | "cancelling"
        | "completed"
        | "blocked"
        | "cancelled"
        | "budget_exhausted"
      readonly budget?: {
        readonly maxAttemptsPerTask?: number
        readonly maxRepairAttempts?: number
        readonly maxParallelTasks?: number
        readonly maxReplans?: number
        readonly maxTurns?: number
        readonly maxDurationMs?: number
        readonly maxCost?: number
      }
      readonly usage: {
        readonly attempts: number
        readonly repairs: number
        readonly turns: number
        readonly cost: number
      }
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }
    readonly tasks: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly title: string
      readonly instructions: string
      readonly dependsOn: ReadonlyArray<string>
      readonly role: string
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly status:
        | "pending"
        | "ready"
        | "running"
        | "verifying"
        | "reviewing"
        | "merging"
        | "rework"
        | "completed"
        | "superseded"
        | "blocked"
        | "cancelled"
      readonly criteria: ReadonlyArray<string>
      readonly attemptCount: number
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }>
    readonly attempts: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly kind: "plan" | "replan" | "execute" | "repair" | "verify" | "review"
      readonly number: number
      readonly sessionID?: string
      readonly status: "admitted" | "running" | "succeeded" | "failed" | "interrupted" | "unknown" | "cancelled"
      readonly ownerID?: string
      readonly fence?: number
      readonly inputRevision: number
      readonly failure?: {
        readonly kind: "error" | "interrupted" | "unknown" | "cancelled" | "permission" | "budget"
        readonly message: string
        readonly retryable: boolean
        readonly details?: JsonValue
      }
      readonly time: { readonly created: number; readonly started?: number; readonly ended?: number }
    }>
    readonly evidence: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionIDs: ReadonlyArray<string>
      readonly kind: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly producer: string
      readonly payload: JsonValue
      readonly digest?: string
      readonly reference?: string
      readonly createdAt: number
    }>
    readonly evaluations: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionID: string
      readonly evidenceIDs: ReadonlyArray<string>
      readonly verdict: "pass" | "fail" | "blocked"
      readonly evaluator: string
      readonly evaluatorVersion: string
      readonly findings: ReadonlyArray<{
        readonly code?: string
        readonly message: string
        readonly severity: "info" | "warning" | "error"
        readonly location?: string
      }>
      readonly allowsRepair: boolean
      readonly createdAt: number
    }>
    readonly handoffs: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly producer: string
      readonly summary: string
      readonly items: ReadonlyArray<{
        readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        readonly text: string
        readonly reference?: string
        readonly memory?: "task" | "project"
        readonly key?: string
        readonly expiresAt?: number
      }>
      readonly evidenceIDs: ReadonlyArray<string>
      readonly recipients: ReadonlyArray<string>
      readonly digest: string
      readonly createdAt: number
    }>
    readonly roles: ReadonlyArray<{
      readonly id: string
      readonly agentID: string
      readonly title: string
      readonly purpose: string
      readonly capabilities: ReadonlyArray<
        "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
      >
      readonly workspaceAccess: "read_only" | "write"
      readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
      readonly accepts: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
      readonly publishes: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
    }>
    readonly memory: {
      readonly entries: ReadonlyArray<{
        readonly key: string
        readonly status: "current" | "conflicted" | "resolved"
        readonly candidates: ReadonlyArray<{
          readonly handoffID: string
          readonly goalID: string
          readonly taskID: string
          readonly producer: string
          readonly item: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly itemDigest: string
          readonly evidenceIDs: ReadonlyArray<string>
          readonly digest: string
          readonly createdAt: number
        }>
        readonly resolution?: {
          readonly id: string
          readonly goalID: string
          readonly location: { readonly directory: string; readonly workspaceID?: string }
          readonly key: string
          readonly handoffID: string
          readonly handoffDigest: string
          readonly itemDigest: string
          readonly action: "select" | "replace" | "delete"
          readonly value?: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly resolver: string
          readonly reason?: string
          readonly createdAt: number
        }
      }>
      readonly resolutions: ReadonlyArray<{
        readonly id: string
        readonly goalID: string
        readonly location: { readonly directory: string; readonly workspaceID?: string }
        readonly key: string
        readonly handoffID: string
        readonly handoffDigest: string
        readonly itemDigest: string
        readonly action: "select" | "replace" | "delete"
        readonly value?: {
          readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
          readonly text: string
          readonly reference?: string
          readonly memory?: "task" | "project"
          readonly key?: string
          readonly expiresAt?: number
        }
        readonly resolver: string
        readonly reason?: string
        readonly createdAt: number
      }>
    }
  }
}["data"]

export type WorkResumeInput = { readonly goalID: { readonly goalID: string }["goalID"] }

export type WorkResumeOutput = void

export type WorkPauseInput = { readonly goalID: { readonly goalID: string }["goalID"] }

export type WorkPauseOutput = void

export type WorkCancelInput = {
  readonly goalID: { readonly goalID: string }["goalID"]
  readonly reason?: { readonly reason?: string | undefined }["reason"]
}

export type WorkCancelOutput = void

export type WorkResolveUnknownInput = {
  readonly goalID: { readonly goalID: string; readonly attemptID: string }["goalID"]
  readonly attemptID: { readonly goalID: string; readonly attemptID: string }["attemptID"]
  readonly resolution: { readonly resolution: "retry"; readonly reason?: string | undefined }["resolution"]
  readonly reason?: { readonly resolution: "retry"; readonly reason?: string | undefined }["reason"]
}

export type WorkResolveUnknownOutput = void

export type WorkResolveMemoryInput = {
  readonly goalID: { readonly goalID: string }["goalID"]
  readonly key: {
    readonly key: string
    readonly handoffID: string
    readonly itemDigest: string
    readonly reason?: string | undefined
  }["key"]
  readonly handoffID: {
    readonly key: string
    readonly handoffID: string
    readonly itemDigest: string
    readonly reason?: string | undefined
  }["handoffID"]
  readonly itemDigest: {
    readonly key: string
    readonly handoffID: string
    readonly itemDigest: string
    readonly reason?: string | undefined
  }["itemDigest"]
  readonly reason?: {
    readonly key: string
    readonly handoffID: string
    readonly itemDigest: string
    readonly reason?: string | undefined
  }["reason"]
}

export type WorkResolveMemoryOutput = {
  readonly data: {
    readonly goal: {
      readonly id: string
      readonly location: { readonly directory: string; readonly workspaceID?: string }
      readonly objective: string
      readonly acceptanceCriteria: ReadonlyArray<{
        readonly id: string
        readonly description: string
        readonly required: boolean
        readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
        readonly verifier?:
          | {
              readonly type: "command"
              readonly command: string
              readonly timeoutMs?: number
              readonly successExitCodes?: ReadonlyArray<number>
            }
          | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
      }>
      readonly roleContracts?: ReadonlyArray<{
        readonly id: string
        readonly agentID: string
        readonly title: string
        readonly purpose: string
        readonly capabilities: ReadonlyArray<
          "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
        >
        readonly workspaceAccess: "read_only" | "write"
        readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
        readonly accepts: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
        readonly publishes: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
      }>
      readonly workerID?: string
      readonly status:
        | "draft"
        | "active"
        | "pausing"
        | "paused"
        | "cancelling"
        | "completed"
        | "blocked"
        | "cancelled"
        | "budget_exhausted"
      readonly budget?: {
        readonly maxAttemptsPerTask?: number
        readonly maxRepairAttempts?: number
        readonly maxParallelTasks?: number
        readonly maxReplans?: number
        readonly maxTurns?: number
        readonly maxDurationMs?: number
        readonly maxCost?: number
      }
      readonly usage: {
        readonly attempts: number
        readonly repairs: number
        readonly turns: number
        readonly cost: number
      }
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }
    readonly tasks: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly title: string
      readonly instructions: string
      readonly dependsOn: ReadonlyArray<string>
      readonly role: string
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly status:
        | "pending"
        | "ready"
        | "running"
        | "verifying"
        | "reviewing"
        | "merging"
        | "rework"
        | "completed"
        | "superseded"
        | "blocked"
        | "cancelled"
      readonly criteria: ReadonlyArray<string>
      readonly attemptCount: number
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }>
    readonly attempts: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly kind: "plan" | "replan" | "execute" | "repair" | "verify" | "review"
      readonly number: number
      readonly sessionID?: string
      readonly status: "admitted" | "running" | "succeeded" | "failed" | "interrupted" | "unknown" | "cancelled"
      readonly ownerID?: string
      readonly fence?: number
      readonly inputRevision: number
      readonly failure?: {
        readonly kind: "error" | "interrupted" | "unknown" | "cancelled" | "permission" | "budget"
        readonly message: string
        readonly retryable: boolean
        readonly details?: JsonValue
      }
      readonly time: { readonly created: number; readonly started?: number; readonly ended?: number }
    }>
    readonly evidence: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionIDs: ReadonlyArray<string>
      readonly kind: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly producer: string
      readonly payload: JsonValue
      readonly digest?: string
      readonly reference?: string
      readonly createdAt: number
    }>
    readonly evaluations: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionID: string
      readonly evidenceIDs: ReadonlyArray<string>
      readonly verdict: "pass" | "fail" | "blocked"
      readonly evaluator: string
      readonly evaluatorVersion: string
      readonly findings: ReadonlyArray<{
        readonly code?: string
        readonly message: string
        readonly severity: "info" | "warning" | "error"
        readonly location?: string
      }>
      readonly allowsRepair: boolean
      readonly createdAt: number
    }>
    readonly handoffs: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly producer: string
      readonly summary: string
      readonly items: ReadonlyArray<{
        readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        readonly text: string
        readonly reference?: string
        readonly memory?: "task" | "project"
        readonly key?: string
        readonly expiresAt?: number
      }>
      readonly evidenceIDs: ReadonlyArray<string>
      readonly recipients: ReadonlyArray<string>
      readonly digest: string
      readonly createdAt: number
    }>
    readonly roles: ReadonlyArray<{
      readonly id: string
      readonly agentID: string
      readonly title: string
      readonly purpose: string
      readonly capabilities: ReadonlyArray<
        "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
      >
      readonly workspaceAccess: "read_only" | "write"
      readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
      readonly accepts: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
      readonly publishes: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
    }>
    readonly memory: {
      readonly entries: ReadonlyArray<{
        readonly key: string
        readonly status: "current" | "conflicted" | "resolved"
        readonly candidates: ReadonlyArray<{
          readonly handoffID: string
          readonly goalID: string
          readonly taskID: string
          readonly producer: string
          readonly item: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly itemDigest: string
          readonly evidenceIDs: ReadonlyArray<string>
          readonly digest: string
          readonly createdAt: number
        }>
        readonly resolution?: {
          readonly id: string
          readonly goalID: string
          readonly location: { readonly directory: string; readonly workspaceID?: string }
          readonly key: string
          readonly handoffID: string
          readonly handoffDigest: string
          readonly itemDigest: string
          readonly action: "select" | "replace" | "delete"
          readonly value?: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly resolver: string
          readonly reason?: string
          readonly createdAt: number
        }
      }>
      readonly resolutions: ReadonlyArray<{
        readonly id: string
        readonly goalID: string
        readonly location: { readonly directory: string; readonly workspaceID?: string }
        readonly key: string
        readonly handoffID: string
        readonly handoffDigest: string
        readonly itemDigest: string
        readonly action: "select" | "replace" | "delete"
        readonly value?: {
          readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
          readonly text: string
          readonly reference?: string
          readonly memory?: "task" | "project"
          readonly key?: string
          readonly expiresAt?: number
        }
        readonly resolver: string
        readonly reason?: string
        readonly createdAt: number
      }>
    }
  }
}["data"]

export type WorkUpdateMemoryInput = {
  readonly goalID: { readonly goalID: string; readonly key: string }["goalID"]
  readonly key: { readonly goalID: string; readonly key: string }["key"]
  readonly kind: {
    readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
    readonly text: string
    readonly reference?: string | undefined
    readonly reason?: string | undefined
  }["kind"]
  readonly text: {
    readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
    readonly text: string
    readonly reference?: string | undefined
    readonly reason?: string | undefined
  }["text"]
  readonly reference?: {
    readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
    readonly text: string
    readonly reference?: string | undefined
    readonly reason?: string | undefined
  }["reference"]
  readonly reason?: {
    readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
    readonly text: string
    readonly reference?: string | undefined
    readonly reason?: string | undefined
  }["reason"]
}

export type WorkUpdateMemoryOutput = {
  readonly data: {
    readonly goal: {
      readonly id: string
      readonly location: { readonly directory: string; readonly workspaceID?: string }
      readonly objective: string
      readonly acceptanceCriteria: ReadonlyArray<{
        readonly id: string
        readonly description: string
        readonly required: boolean
        readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
        readonly verifier?:
          | {
              readonly type: "command"
              readonly command: string
              readonly timeoutMs?: number
              readonly successExitCodes?: ReadonlyArray<number>
            }
          | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
      }>
      readonly roleContracts?: ReadonlyArray<{
        readonly id: string
        readonly agentID: string
        readonly title: string
        readonly purpose: string
        readonly capabilities: ReadonlyArray<
          "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
        >
        readonly workspaceAccess: "read_only" | "write"
        readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
        readonly accepts: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
        readonly publishes: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
      }>
      readonly workerID?: string
      readonly status:
        | "draft"
        | "active"
        | "pausing"
        | "paused"
        | "cancelling"
        | "completed"
        | "blocked"
        | "cancelled"
        | "budget_exhausted"
      readonly budget?: {
        readonly maxAttemptsPerTask?: number
        readonly maxRepairAttempts?: number
        readonly maxParallelTasks?: number
        readonly maxReplans?: number
        readonly maxTurns?: number
        readonly maxDurationMs?: number
        readonly maxCost?: number
      }
      readonly usage: {
        readonly attempts: number
        readonly repairs: number
        readonly turns: number
        readonly cost: number
      }
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }
    readonly tasks: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly title: string
      readonly instructions: string
      readonly dependsOn: ReadonlyArray<string>
      readonly role: string
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly status:
        | "pending"
        | "ready"
        | "running"
        | "verifying"
        | "reviewing"
        | "merging"
        | "rework"
        | "completed"
        | "superseded"
        | "blocked"
        | "cancelled"
      readonly criteria: ReadonlyArray<string>
      readonly attemptCount: number
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }>
    readonly attempts: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly kind: "plan" | "replan" | "execute" | "repair" | "verify" | "review"
      readonly number: number
      readonly sessionID?: string
      readonly status: "admitted" | "running" | "succeeded" | "failed" | "interrupted" | "unknown" | "cancelled"
      readonly ownerID?: string
      readonly fence?: number
      readonly inputRevision: number
      readonly failure?: {
        readonly kind: "error" | "interrupted" | "unknown" | "cancelled" | "permission" | "budget"
        readonly message: string
        readonly retryable: boolean
        readonly details?: JsonValue
      }
      readonly time: { readonly created: number; readonly started?: number; readonly ended?: number }
    }>
    readonly evidence: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionIDs: ReadonlyArray<string>
      readonly kind: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly producer: string
      readonly payload: JsonValue
      readonly digest?: string
      readonly reference?: string
      readonly createdAt: number
    }>
    readonly evaluations: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionID: string
      readonly evidenceIDs: ReadonlyArray<string>
      readonly verdict: "pass" | "fail" | "blocked"
      readonly evaluator: string
      readonly evaluatorVersion: string
      readonly findings: ReadonlyArray<{
        readonly code?: string
        readonly message: string
        readonly severity: "info" | "warning" | "error"
        readonly location?: string
      }>
      readonly allowsRepair: boolean
      readonly createdAt: number
    }>
    readonly handoffs: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly producer: string
      readonly summary: string
      readonly items: ReadonlyArray<{
        readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        readonly text: string
        readonly reference?: string
        readonly memory?: "task" | "project"
        readonly key?: string
        readonly expiresAt?: number
      }>
      readonly evidenceIDs: ReadonlyArray<string>
      readonly recipients: ReadonlyArray<string>
      readonly digest: string
      readonly createdAt: number
    }>
    readonly roles: ReadonlyArray<{
      readonly id: string
      readonly agentID: string
      readonly title: string
      readonly purpose: string
      readonly capabilities: ReadonlyArray<
        "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
      >
      readonly workspaceAccess: "read_only" | "write"
      readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
      readonly accepts: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
      readonly publishes: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
    }>
    readonly memory: {
      readonly entries: ReadonlyArray<{
        readonly key: string
        readonly status: "current" | "conflicted" | "resolved"
        readonly candidates: ReadonlyArray<{
          readonly handoffID: string
          readonly goalID: string
          readonly taskID: string
          readonly producer: string
          readonly item: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly itemDigest: string
          readonly evidenceIDs: ReadonlyArray<string>
          readonly digest: string
          readonly createdAt: number
        }>
        readonly resolution?: {
          readonly id: string
          readonly goalID: string
          readonly location: { readonly directory: string; readonly workspaceID?: string }
          readonly key: string
          readonly handoffID: string
          readonly handoffDigest: string
          readonly itemDigest: string
          readonly action: "select" | "replace" | "delete"
          readonly value?: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly resolver: string
          readonly reason?: string
          readonly createdAt: number
        }
      }>
      readonly resolutions: ReadonlyArray<{
        readonly id: string
        readonly goalID: string
        readonly location: { readonly directory: string; readonly workspaceID?: string }
        readonly key: string
        readonly handoffID: string
        readonly handoffDigest: string
        readonly itemDigest: string
        readonly action: "select" | "replace" | "delete"
        readonly value?: {
          readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
          readonly text: string
          readonly reference?: string
          readonly memory?: "task" | "project"
          readonly key?: string
          readonly expiresAt?: number
        }
        readonly resolver: string
        readonly reason?: string
        readonly createdAt: number
      }>
    }
  }
}["data"]

export type WorkDeleteMemoryInput = {
  readonly goalID: { readonly goalID: string; readonly key: string }["goalID"]
  readonly key: { readonly goalID: string; readonly key: string }["key"]
}

export type WorkDeleteMemoryOutput = {
  readonly data: {
    readonly goal: {
      readonly id: string
      readonly location: { readonly directory: string; readonly workspaceID?: string }
      readonly objective: string
      readonly acceptanceCriteria: ReadonlyArray<{
        readonly id: string
        readonly description: string
        readonly required: boolean
        readonly evidence: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
        readonly verifier?:
          | {
              readonly type: "command"
              readonly command: string
              readonly timeoutMs?: number
              readonly successExitCodes?: ReadonlyArray<number>
            }
          | { readonly type: "file"; readonly path: string; readonly expected: "exists" | "file" | "directory" }
      }>
      readonly roleContracts?: ReadonlyArray<{
        readonly id: string
        readonly agentID: string
        readonly title: string
        readonly purpose: string
        readonly capabilities: ReadonlyArray<
          "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
        >
        readonly workspaceAccess: "read_only" | "write"
        readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
        readonly accepts: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
        readonly publishes: ReadonlyArray<
          "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        >
      }>
      readonly workerID?: string
      readonly status:
        | "draft"
        | "active"
        | "pausing"
        | "paused"
        | "cancelling"
        | "completed"
        | "blocked"
        | "cancelled"
        | "budget_exhausted"
      readonly budget?: {
        readonly maxAttemptsPerTask?: number
        readonly maxRepairAttempts?: number
        readonly maxParallelTasks?: number
        readonly maxReplans?: number
        readonly maxTurns?: number
        readonly maxDurationMs?: number
        readonly maxCost?: number
      }
      readonly usage: {
        readonly attempts: number
        readonly repairs: number
        readonly turns: number
        readonly cost: number
      }
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }
    readonly tasks: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly title: string
      readonly instructions: string
      readonly dependsOn: ReadonlyArray<string>
      readonly role: string
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly status:
        | "pending"
        | "ready"
        | "running"
        | "verifying"
        | "reviewing"
        | "merging"
        | "rework"
        | "completed"
        | "superseded"
        | "blocked"
        | "cancelled"
      readonly criteria: ReadonlyArray<string>
      readonly attemptCount: number
      readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
      readonly revision: number
    }>
    readonly attempts: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly kind: "plan" | "replan" | "execute" | "repair" | "verify" | "review"
      readonly number: number
      readonly sessionID?: string
      readonly status: "admitted" | "running" | "succeeded" | "failed" | "interrupted" | "unknown" | "cancelled"
      readonly ownerID?: string
      readonly fence?: number
      readonly inputRevision: number
      readonly failure?: {
        readonly kind: "error" | "interrupted" | "unknown" | "cancelled" | "permission" | "budget"
        readonly message: string
        readonly retryable: boolean
        readonly details?: JsonValue
      }
      readonly time: { readonly created: number; readonly started?: number; readonly ended?: number }
    }>
    readonly evidence: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionIDs: ReadonlyArray<string>
      readonly kind: "command" | "test" | "diff" | "artifact" | "review" | "manual" | "external"
      readonly producer: string
      readonly payload: JsonValue
      readonly digest?: string
      readonly reference?: string
      readonly createdAt: number
    }>
    readonly evaluations: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly criterionID: string
      readonly evidenceIDs: ReadonlyArray<string>
      readonly verdict: "pass" | "fail" | "blocked"
      readonly evaluator: string
      readonly evaluatorVersion: string
      readonly findings: ReadonlyArray<{
        readonly code?: string
        readonly message: string
        readonly severity: "info" | "warning" | "error"
        readonly location?: string
      }>
      readonly allowsRepair: boolean
      readonly createdAt: number
    }>
    readonly handoffs: ReadonlyArray<{
      readonly id: string
      readonly goalID: string
      readonly taskID: string
      readonly attemptID: string
      readonly producer: string
      readonly summary: string
      readonly items: ReadonlyArray<{
        readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
        readonly text: string
        readonly reference?: string
        readonly memory?: "task" | "project"
        readonly key?: string
        readonly expiresAt?: number
      }>
      readonly evidenceIDs: ReadonlyArray<string>
      readonly recipients: ReadonlyArray<string>
      readonly digest: string
      readonly createdAt: number
    }>
    readonly roles: ReadonlyArray<{
      readonly id: string
      readonly agentID: string
      readonly title: string
      readonly purpose: string
      readonly capabilities: ReadonlyArray<
        "coordinate" | "plan" | "research" | "design" | "implement" | "verify" | "audit"
      >
      readonly workspaceAccess: "read_only" | "write"
      readonly allowedIsolation: ReadonlyArray<"shared" | "worktree">
      readonly accepts: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
      readonly publishes: ReadonlyArray<
        "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
      >
    }>
    readonly memory: {
      readonly entries: ReadonlyArray<{
        readonly key: string
        readonly status: "current" | "conflicted" | "resolved"
        readonly candidates: ReadonlyArray<{
          readonly handoffID: string
          readonly goalID: string
          readonly taskID: string
          readonly producer: string
          readonly item: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly itemDigest: string
          readonly evidenceIDs: ReadonlyArray<string>
          readonly digest: string
          readonly createdAt: number
        }>
        readonly resolution?: {
          readonly id: string
          readonly goalID: string
          readonly location: { readonly directory: string; readonly workspaceID?: string }
          readonly key: string
          readonly handoffID: string
          readonly handoffDigest: string
          readonly itemDigest: string
          readonly action: "select" | "replace" | "delete"
          readonly value?: {
            readonly kind:
              | "result"
              | "fact"
              | "decision"
              | "constraint"
              | "risk"
              | "artifact"
              | "lesson"
              | "next_action"
            readonly text: string
            readonly reference?: string
            readonly memory?: "task" | "project"
            readonly key?: string
            readonly expiresAt?: number
          }
          readonly resolver: string
          readonly reason?: string
          readonly createdAt: number
        }
      }>
      readonly resolutions: ReadonlyArray<{
        readonly id: string
        readonly goalID: string
        readonly location: { readonly directory: string; readonly workspaceID?: string }
        readonly key: string
        readonly handoffID: string
        readonly handoffDigest: string
        readonly itemDigest: string
        readonly action: "select" | "replace" | "delete"
        readonly value?: {
          readonly kind: "result" | "fact" | "decision" | "constraint" | "risk" | "artifact" | "lesson" | "next_action"
          readonly text: string
          readonly reference?: string
          readonly memory?: "task" | "project"
          readonly key?: string
          readonly expiresAt?: number
        }
        readonly resolver: string
        readonly reason?: string
        readonly createdAt: number
      }>
    }
  }
}["data"]

export type MessagesListInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: {
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly cursor?: string | undefined
  }["limit"]
  readonly order?: {
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly cursor?: string | undefined
  }["order"]
  readonly cursor?: {
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly cursor?: string | undefined
  }["cursor"]
}

export type MessagesListOutput = {
  readonly data: ReadonlyArray<
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "agent-switched"
        readonly agent: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "model-switched"
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly text: string
        readonly files?: ReadonlyArray<{
          readonly uri: string
          readonly mime: string
          readonly name?: string
          readonly description?: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly agents?: ReadonlyArray<{
          readonly name: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly type: "user"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly sessionID: string
        readonly text: string
        readonly type: "synthetic"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "system"
        readonly text: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "shell"
        readonly callID: string
        readonly command: string
        readonly output: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "assistant"
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly inputSequence?: number
        readonly contextEpoch?: number
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly id: string; readonly text: string }
          | {
              readonly type: "reasoning"
              readonly id: string
              readonly text: string
              readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              readonly time?: { readonly created: number; readonly completed?: number }
            }
          | {
              readonly type: "tool"
              readonly id: string
              readonly name: string
              readonly provider?: {
                readonly executed: boolean
                readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
                readonly resultMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              }
              readonly state:
                | { readonly status: "pending"; readonly input: string }
                | {
                    readonly status: "running"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                  }
                | {
                    readonly status: "completed"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly attachments?: ReadonlyArray<{
                      readonly uri: string
                      readonly mime: string
                      readonly name?: string
                      readonly description?: string
                      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
                    }>
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly result?: JsonValue
                  }
                | {
                    readonly status: "error"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly error: { readonly type: "unknown"; readonly message: string }
                    readonly result?: JsonValue
                  }
              readonly time: {
                readonly created: number
                readonly ran?: number
                readonly completed?: number
                readonly pruned?: number
              }
            }
        >
        readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: ReadonlyArray<string> }
        readonly finish?: string
        readonly cost?: number
        readonly tokens?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly error?: { readonly type: "unknown"; readonly message: string }
      }
    | {
        readonly type: "compaction"
        readonly reason: "auto" | "manual"
        readonly summary: string
        readonly recent: string
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
      }
  >
  readonly cursor: { readonly previous?: string | null; readonly next?: string | null }
}

export type ModelsListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type ModelsListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly providerID: string
    readonly family?: string
    readonly name: string
    readonly api:
      | {
          readonly id: string
          readonly type: "aisdk"
          readonly package: string
          readonly url?: string
          readonly settings?: { readonly [x: string]: JsonValue }
        }
      | {
          readonly id: string
          readonly type: "native"
          readonly url?: string
          readonly settings: { readonly [x: string]: JsonValue }
        }
    readonly capabilities: {
      readonly tools: boolean
      readonly input: ReadonlyArray<string>
      readonly output: ReadonlyArray<string>
    }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
      readonly variant?: string
    }
    readonly variants: ReadonlyArray<{
      readonly id: string
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }>
    readonly time: { readonly released: number }
    readonly cost: ReadonlyArray<{
      readonly tier?: { readonly type: "context"; readonly size: number }
      readonly input: number
      readonly output: number
      readonly cache: { readonly read: number; readonly write: number }
    }>
    readonly status: "alpha" | "beta" | "deprecated" | "active"
    readonly enabled: boolean
    readonly limit: { readonly context: number; readonly input?: number; readonly output: number }
  }>
}

export type ProvidersListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type ProvidersListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly integrationID?: string
    readonly name: string
    readonly disabled?: boolean
    readonly api:
      | {
          readonly type: "aisdk"
          readonly package: string
          readonly url?: string
          readonly settings?: { readonly [x: string]: JsonValue }
        }
      | { readonly type: "native"; readonly url?: string; readonly settings: { readonly [x: string]: JsonValue } }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }
  }>
}

export type ProvidersGetInput = {
  readonly providerID: { readonly providerID: string }["providerID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type ProvidersGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly integrationID?: string
    readonly name: string
    readonly disabled?: boolean
    readonly api:
      | {
          readonly type: "aisdk"
          readonly package: string
          readonly url?: string
          readonly settings?: { readonly [x: string]: JsonValue }
        }
      | { readonly type: "native"; readonly url?: string; readonly settings: { readonly [x: string]: JsonValue } }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }
  }
}

export type IntegrationsListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type IntegrationsListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly methods: ReadonlyArray<
      | {
          readonly id: string
          readonly type: "oauth"
          readonly label: string
          readonly prompts?: ReadonlyArray<
            | {
                readonly type: "text"
                readonly key: string
                readonly message: string
                readonly placeholder?: string
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
            | {
                readonly type: "select"
                readonly key: string
                readonly message: string
                readonly options: ReadonlyArray<{
                  readonly label: string
                  readonly value: string
                  readonly hint?: string
                }>
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
          >
        }
      | {
          readonly type: "key"
          readonly label?: string
          readonly prompts?: ReadonlyArray<
            | {
                readonly type: "text"
                readonly key: string
                readonly message: string
                readonly placeholder?: string
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
            | {
                readonly type: "select"
                readonly key: string
                readonly message: string
                readonly options: ReadonlyArray<{
                  readonly label: string
                  readonly value: string
                  readonly hint?: string
                }>
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
          >
        }
      | { readonly type: "env"; readonly names: ReadonlyArray<string> }
    >
    readonly connections: ReadonlyArray<
      | { readonly type: "credential"; readonly id: string; readonly label: string }
      | { readonly type: "env"; readonly name: string }
    >
  }>
}

export type IntegrationsGetInput = {
  readonly integrationID: { readonly integrationID: string }["integrationID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type IntegrationsGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly name: string
    readonly methods: ReadonlyArray<
      | {
          readonly id: string
          readonly type: "oauth"
          readonly label: string
          readonly prompts?: ReadonlyArray<
            | {
                readonly type: "text"
                readonly key: string
                readonly message: string
                readonly placeholder?: string
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
            | {
                readonly type: "select"
                readonly key: string
                readonly message: string
                readonly options: ReadonlyArray<{
                  readonly label: string
                  readonly value: string
                  readonly hint?: string
                }>
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
          >
        }
      | {
          readonly type: "key"
          readonly label?: string
          readonly prompts?: ReadonlyArray<
            | {
                readonly type: "text"
                readonly key: string
                readonly message: string
                readonly placeholder?: string
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
            | {
                readonly type: "select"
                readonly key: string
                readonly message: string
                readonly options: ReadonlyArray<{
                  readonly label: string
                  readonly value: string
                  readonly hint?: string
                }>
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
          >
        }
      | { readonly type: "env"; readonly names: ReadonlyArray<string> }
    >
    readonly connections: ReadonlyArray<
      | { readonly type: "credential"; readonly id: string; readonly label: string }
      | { readonly type: "env"; readonly name: string }
    >
  } | null
}

export type IntegrationsConnectKeyInput = {
  readonly integrationID: { readonly integrationID: string }["integrationID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly key: {
    readonly key: string
    readonly inputs?: { readonly [x: string]: string } | undefined
    readonly label?: string | undefined
  }["key"]
  readonly inputs?: {
    readonly key: string
    readonly inputs?: { readonly [x: string]: string } | undefined
    readonly label?: string | undefined
  }["inputs"]
  readonly label?: {
    readonly key: string
    readonly inputs?: { readonly [x: string]: string } | undefined
    readonly label?: string | undefined
  }["label"]
}

export type IntegrationsConnectKeyOutput = void

export type IntegrationsConnectOauthInput = {
  readonly integrationID: { readonly integrationID: string }["integrationID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly methodID: {
    readonly methodID: string
    readonly inputs: { readonly [x: string]: string }
    readonly label?: string | undefined
  }["methodID"]
  readonly inputs: {
    readonly methodID: string
    readonly inputs: { readonly [x: string]: string }
    readonly label?: string | undefined
  }["inputs"]
  readonly label?: {
    readonly methodID: string
    readonly inputs: { readonly [x: string]: string }
    readonly label?: string | undefined
  }["label"]
}

export type IntegrationsConnectOauthOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly attemptID: string
    readonly url: string
    readonly instructions: string
    readonly mode: "auto" | "code"
    readonly time: {
      readonly created: number | "Infinity" | "-Infinity" | "NaN"
      readonly expires: number | "Infinity" | "-Infinity" | "NaN"
    }
  }
}

export type IntegrationsAttemptStatusInput = {
  readonly attemptID: { readonly attemptID: string }["attemptID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type IntegrationsAttemptStatusOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data:
    | {
        readonly status: "pending"
        readonly time: {
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly expires: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
    | {
        readonly status: "complete"
        readonly time: {
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly expires: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
    | {
        readonly status: "failed"
        readonly message: string
        readonly time: {
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly expires: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
    | {
        readonly status: "expired"
        readonly time: {
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly expires: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
}

export type IntegrationsAttemptCompleteInput = {
  readonly attemptID: { readonly attemptID: string }["attemptID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly code?: { readonly code?: string | undefined }["code"]
}

export type IntegrationsAttemptCompleteOutput = void

export type IntegrationsAttemptCancelInput = {
  readonly attemptID: { readonly attemptID: string }["attemptID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type IntegrationsAttemptCancelOutput = void

export type CredentialsUpdateInput = {
  readonly credentialID: { readonly credentialID: string }["credentialID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly label: { readonly label: string }["label"]
}

export type CredentialsUpdateOutput = void

export type CredentialsRemoveInput = {
  readonly credentialID: { readonly credentialID: string }["credentialID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type CredentialsRemoveOutput = void

export type McpStatusInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type McpStatusOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly [x: string]:
      | { readonly status: "connected"; readonly tools: number | "Infinity" | "-Infinity" | "NaN" }
      | { readonly status: "disabled" }
      | {
          readonly status: "needs_auth"
          readonly error: string
          readonly integrationID: string
          readonly methodID: string
        }
      | { readonly status: "failed"; readonly error: string }
  }
}

export type McpResourcesInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type McpResourcesOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly [x: string]: {
      readonly name: string
      readonly uri: string
      readonly description?: string | null
      readonly mimeType?: string | null
      readonly client: string
    }
  }
}

export type McpConnectInput = {
  readonly name: { readonly name: string }["name"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type McpConnectOutput = void

export type McpDisconnectInput = {
  readonly name: { readonly name: string }["name"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type McpDisconnectOutput = void

export type PermissionsListRequestsInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type PermissionsListRequestsOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
  }>
}

export type PermissionsListSavedInput = {
  readonly projectID?: { readonly projectID?: string | undefined }["projectID"]
}

export type PermissionsListSavedOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly projectID: string
    readonly action: string
    readonly resource: string
  }>
}["data"]

export type PermissionsRemoveSavedInput = { readonly id: { readonly id: string }["id"] }

export type PermissionsRemoveSavedOutput = void

export type PermissionsCreateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["id"]
  readonly action: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["action"]
  readonly resources: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["resources"]
  readonly save?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["save"]
  readonly metadata?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["metadata"]
  readonly source?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["source"]
  readonly agent?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["agent"]
}

export type PermissionsCreateOutput = {
  readonly data: { readonly id: string; readonly effect: "allow" | "deny" | "ask" }
}["data"]

export type PermissionsListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type PermissionsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
  }>
}["data"]

export type PermissionsGetInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
}

export type PermissionsGetOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
  }
}["data"]

export type PermissionsReplyInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
  readonly reply: { readonly reply: "once" | "always" | "reject"; readonly message?: string | undefined }["reply"]
  readonly message?: { readonly reply: "once" | "always" | "reject"; readonly message?: string | undefined }["message"]
}

export type PermissionsReplyOutput = void

export type FilesListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly path?: string | undefined
  }["location"]
  readonly path?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly path?: string | undefined
  }["path"]
}

export type FilesListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{ readonly path: string; readonly type: "file" | "directory" }>
}

export type FilesFindInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly query: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["query"]
  readonly type?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["type"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type FilesFindOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{ readonly path: string; readonly type: "file" | "directory" }>
}

export type CommandsListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type CommandsListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly name: string
    readonly template: string
    readonly description?: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly subtask?: boolean
  }>
}

export type SkillsListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type SkillsListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly name: string
    readonly description?: string
    readonly slash?: boolean
    readonly location: string
    readonly content: string
  }>
}

export type EventsSubscribeOutput = ZaovraEventEncoded

export type PtysListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type PtysListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
  }>
}

export type PtysCreateInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly command?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["command"]
  readonly args?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["args"]
  readonly cwd?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["cwd"]
  readonly title?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["title"]
  readonly env?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["env"]
}

export type PtysCreateOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
  }
}

export type PtysGetInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type PtysGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
  }
}

export type PtysUpdateInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly title?: {
    readonly title?: string
    readonly size?: { readonly rows: number; readonly cols: number }
  }["title"]
  readonly size?: { readonly title?: string; readonly size?: { readonly rows: number; readonly cols: number } }["size"]
}

export type PtysUpdateOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
  }
}

export type PtysRemoveInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type PtysRemoveOutput = void

export type QuestionsListRequestsInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type QuestionsListRequestsOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly questions: ReadonlyArray<{
      readonly question: string
      readonly header: string
      readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
      readonly multiple?: boolean
      readonly custom?: boolean
    }>
    readonly tool?: { readonly messageID: string; readonly callID: string }
  }>
}

export type QuestionsListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type QuestionsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly questions: ReadonlyArray<{
      readonly question: string
      readonly header: string
      readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
      readonly multiple?: boolean
      readonly custom?: boolean
    }>
    readonly tool?: { readonly messageID: string; readonly callID: string }
  }>
}["data"]

export type QuestionsReplyInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
  readonly answers: { readonly answers: ReadonlyArray<ReadonlyArray<string>> }["answers"]
}

export type QuestionsReplyOutput = void

export type QuestionsRejectInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
}

export type QuestionsRejectOutput = void

export type ReferencesListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type ReferencesListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly name: string
    readonly path: string
    readonly description?: string
    readonly hidden?: boolean
    readonly source:
      | { readonly type: "local"; readonly path: string; readonly description?: string; readonly hidden?: boolean }
      | {
          readonly type: "git"
          readonly repository: string
          readonly branch?: string
          readonly description?: string
          readonly hidden?: boolean
        }
  }>
}

export type ProjectCopiesCreateInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly strategy: { readonly strategy: string; readonly directory: string; readonly name?: string }["strategy"]
  readonly directory: { readonly strategy: string; readonly directory: string; readonly name?: string }["directory"]
  readonly name?: { readonly strategy: string; readonly directory: string; readonly name?: string }["name"]
}

export type ProjectCopiesCreateOutput = { readonly directory: string }

export type ProjectCopiesRemoveInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly directory: { readonly directory: string; readonly force: boolean }["directory"]
  readonly force: { readonly directory: string; readonly force: boolean }["force"]
}

export type ProjectCopiesRemoveOutput = void

export type ProjectCopiesRefreshInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type ProjectCopiesRefreshOutput = void
