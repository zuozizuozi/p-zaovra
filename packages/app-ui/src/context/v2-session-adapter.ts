import type {
  Message,
  Part,
  Session,
  SessionMessage,
  SessionMessageAssistantTool,
  SessionInputAdmitted,
  SessionV2Info,
} from "@zaovra-ai/sdk/v2/client"
import { toLegacySessionSummary } from "./global-sync/home-session-index"

export type SessionView = Session & Pick<SessionV2Info, "agent" | "model">

export function adaptPartID(messageID: string, partID: string) {
  // Provider part IDs such as text-0 are only unique within one message.
  return `${messageID}:${partID}`
}

export function adaptSession(session: SessionV2Info): SessionView {
  return { ...toLegacySessionSummary(session), agent: session.agent, model: session.model }
}

export function adaptSessionInput(session: Pick<SessionV2Info, "id" | "agent" | "model">, input: SessionInputAdmitted) {
  return {
    message: {
      id: input.id,
      sessionID: session.id,
      role: "user" as const,
      time: { created: input.timeCreated },
      agent: input.prompt.selection?.agent ?? session.agent ?? "build",
      model: {
        providerID: input.prompt.selection?.model.providerID ?? session.model?.providerID ?? "unknown",
        modelID: input.prompt.selection?.model.id ?? session.model?.id ?? "unknown",
        variant: input.prompt.selection ? input.prompt.selection.model.variant : session.model?.variant,
      },
    },
    parts: [
      ...(input.prompt.text
        ? [
            {
              id: `${input.id}:text`,
              sessionID: session.id,
              messageID: input.id,
              type: "text" as const,
              text: input.prompt.invocation ?? input.prompt.text,
            },
          ]
        : []),
      ...(input.prompt.files ?? []).map((file, index) => ({
        id: `${input.id}:file:${index}`,
        sessionID: session.id,
        messageID: input.id,
        type: "file" as const,
        mime: file.mime,
        filename: file.name,
        url: file.uri,
      })),
      ...(input.prompt.agents ?? []).map((agent, index) => ({
        id: `${input.id}:agent:${index}`,
        sessionID: session.id,
        messageID: input.id,
        type: "agent" as const,
        name: agent.name,
        source: agent.source
          ? { value: agent.source.text, start: agent.source.start, end: agent.source.end }
          : undefined,
      })),
    ],
  }
}

export function adaptSessionMessages(session: SessionV2Info, messages: SessionMessage[], parentID?: string) {
  const result: { message: Message; parts: Part[] }[] = []
  const state = { parentID }

  for (const item of messages.toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))) {
    if (item.type === "user") {
      state.parentID = item.id
      result.push({
        message: {
          id: item.id,
          sessionID: session.id,
          role: "user",
          time: item.time,
          agent: item.selection?.agent ?? session.agent ?? "build",
          model: {
            providerID: item.selection?.model.providerID ?? session.model?.providerID ?? "unknown",
            modelID: item.selection?.model.id ?? session.model?.id ?? "unknown",
            variant: item.selection ? item.selection.model.variant : session.model?.variant,
          },
        },
        parts: [
          ...(item.text
            ? [
                {
                  id: `${item.id}:text`,
                  sessionID: session.id,
                  messageID: item.id,
                  type: "text" as const,
                  text: item.invocation ?? item.text,
                },
              ]
            : []),
          ...(item.files ?? []).map((file, index) => ({
            id: `${item.id}:file:${index}`,
            sessionID: session.id,
            messageID: item.id,
            type: "file" as const,
            mime: file.mime,
            filename: file.name,
            url: file.uri,
          })),
          ...(item.agents ?? []).map((agent, index) => ({
            id: `${item.id}:agent:${index}`,
            sessionID: session.id,
            messageID: item.id,
            type: "agent" as const,
            name: agent.name,
            source: agent.source
              ? { value: agent.source.text, start: agent.source.start, end: agent.source.end }
              : undefined,
          })),
        ],
      })
      continue
    }

    if (item.type === "assistant" && state.parentID) {
      result.push({
        message: {
          id: item.id,
          sessionID: session.id,
          role: "assistant",
          time: item.time,
          error: item.error ? { name: "UnknownError", data: { message: item.error.message } } : undefined,
          parentID: state.parentID,
          modelID: item.model.id,
          providerID: item.model.providerID,
          mode: "build",
          agent: item.agent,
          path: { cwd: session.location.directory, root: session.location.directory },
          cost: item.cost ?? 0,
          tokens: item.tokens ?? {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          variant: item.model.variant,
          finish: item.finish,
        },
        parts: item.content.flatMap((content): Part[] => {
          if (content.type === "text")
            return [
              {
                id: adaptPartID(item.id, content.id),
                sessionID: session.id,
                messageID: item.id,
                type: "text",
                text: content.text,
              },
            ]
          if (content.type === "reasoning")
            return [
              {
                id: adaptPartID(item.id, content.id),
                sessionID: session.id,
                messageID: item.id,
                type: "reasoning",
                text: content.text,
                metadata: content.providerMetadata,
                time: {
                  start: content.time?.created ?? item.time.created,
                  end: content.time?.completed,
                },
              },
            ]
          return [adaptTool(session.id, item.id, content)]
        }),
      })
      continue
    }

    if (item.type === "synthetic" || item.type === "shell") {
      state.parentID = item.id
      result.push({
        message: {
          id: item.id,
          sessionID: session.id,
          role: "user",
          time: { created: item.time.created },
          agent: session.agent ?? "build",
          model: {
            providerID: session.model?.providerID ?? "unknown",
            modelID: session.model?.id ?? "unknown",
            variant: session.model?.variant,
          },
        },
        parts: [
          {
            id: `${item.id}:text`,
            sessionID: session.id,
            messageID: item.id,
            type: "text",
            text: item.type === "shell" ? `$ ${item.command}\n\n${item.output}` : item.text,
            synthetic: true,
            ...(item.type === "shell" ? { metadata: { zaovraShellPending: item.time.completed === undefined } } : {}),
          },
        ],
      })
    }
  }

  return result
}

/** Unfinished history is not proof that a process is still alive after reconnecting. */
export function hasUnfinishedShell(messages: readonly Message[], parts: Readonly<Record<string, Part[]>>) {
  return messages.some((message) =>
    parts[message.id]?.some((part) => part.type === "text" && part.metadata?.zaovraShellPending === true),
  )
}

function adaptTool(sessionID: string, messageID: string, tool: SessionMessageAssistantTool): Part {
  const content = tool.state.status === "pending" ? [] : tool.state.content
  const output = content
    .map((item) => (item.type === "text" ? item.text : `[${item.name ?? item.uri}](${item.uri})`))
    .join("\n\n")
  const rawInput = tool.state.status === "pending" ? {} : tool.state.input
  const rawStructured = tool.state.status === "pending" ? {} : tool.state.structured
  const lsp = rawStructured.lsp
  const diagnostics = lsp && typeof lsp === "object" && "diagnostics" in lsp ? lsp.diagnostics : undefined
  const filePath = rawInput.filePath ?? rawInput.path
  const structured =
    ["write", "edit"].includes(tool.name) &&
    diagnostics &&
    typeof diagnostics === "object" &&
    !Array.isArray(diagnostics)
      ? {
          ...rawStructured,
          diagnostics: {
            ...diagnostics,
            ...(typeof filePath === "string" &&
            typeof rawStructured.target === "string" &&
            rawStructured.target in diagnostics
              ? { [filePath]: diagnostics[rawStructured.target as keyof typeof diagnostics] }
              : {}),
          },
        }
      : rawStructured
  const input = ["read", "write", "edit"].includes(tool.name)
    ? {
        ...rawInput,
        filePath: rawInput.filePath ?? rawInput.path,
        ...(tool.name === "write" && typeof structured.content === "string" ? { content: structured.content } : {}),
      }
    : rawInput
  const metadata =
    tool.name === "task" && typeof structured.task_id === "string"
      ? { ...structured, sessionId: structured.task_id }
      : tool.name === "edit" && Array.isArray(structured.files) && structured.files[0]
        ? { ...structured, filediff: structured.files[0] }
        : tool.name === "apply_patch" && Array.isArray(structured.files)
          ? {
              ...structured,
              ...(Array.isArray(structured.applied)
                ? {
                    diagnostics: Object.fromEntries(
                      structured.applied.flatMap((item: unknown) => {
                        if (
                          !item ||
                          typeof item !== "object" ||
                          !("resource" in item) ||
                          typeof item.resource !== "string" ||
                          !("target" in item) ||
                          typeof item.target !== "string" ||
                          !("lsp" in item) ||
                          !item.lsp ||
                          typeof item.lsp !== "object" ||
                          !("diagnostics" in item.lsp)
                        )
                          return []
                        const diagnostics = item.lsp.diagnostics
                        if (!diagnostics || typeof diagnostics !== "object" || !(item.target in diagnostics)) return []
                        const issues = diagnostics[item.target as keyof typeof diagnostics]
                        return Array.isArray(issues) ? [[item.resource, issues]] : []
                      }),
                    ),
                  }
                : {}),
              files: structured.files.map((file: unknown) => {
                if (!file || typeof file !== "object" || !("file" in file) || typeof file.file !== "string") return file
                const status = "status" in file ? file.status : undefined
                return {
                  ...file,
                  filePath: file.file,
                  relativePath: file.file,
                  type: status === "added" ? "add" : status === "deleted" ? "delete" : "update",
                }
              }),
            }
          : structured
  const state = (() => {
    if (tool.state.status === "pending") return { status: "pending" as const, input, raw: tool.state.input }
    if (tool.state.status === "running")
      return {
        status: "running" as const,
        input,
        title: tool.name,
        metadata,
        time: { start: tool.time.ran ?? tool.time.created },
      }
    if (tool.state.status === "error")
      return {
        status: "error" as const,
        input,
        error: tool.state.error.message,
        metadata,
        time: { start: tool.time.ran ?? tool.time.created, end: tool.time.completed ?? tool.time.created },
      }
    return {
      status: "completed" as const,
      input,
      output,
      title: tool.name,
      metadata,
      time: { start: tool.time.ran ?? tool.time.created, end: tool.time.completed ?? tool.time.created },
      attachments: tool.state.attachments?.map((file, index) => ({
        id: `${tool.id}:attachment:${index}`,
        sessionID,
        messageID,
        type: "file" as const,
        mime: file.mime,
        filename: file.name,
        url: file.uri,
      })),
    }
  })()

  return {
    id: adaptPartID(messageID, tool.id),
    sessionID,
    messageID,
    type: "tool",
    callID: tool.id,
    tool: tool.name,
    state,
    metadata: tool.provider?.resultMetadata,
  }
}
