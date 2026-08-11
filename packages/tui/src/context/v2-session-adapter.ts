import type {
  Message,
  Part,
  Session,
  SessionMessage,
  SessionMessageAssistantTool,
  SessionV2Info,
} from "@zaovra-ai/sdk/v2"

export function adaptSession(session: SessionV2Info): Session {
  return {
    id: session.id,
    slug: session.id,
    projectID: session.projectID,
    workspaceID: session.location.workspaceID,
    directory: session.location.directory,
    path: session.subpath,
    parentID: session.parentID,
    cost: session.cost,
    tokens: session.tokens,
    title: session.title,
    agent: session.agent,
    model: session.model,
    version: "",
    time: session.time,
  }
}

export function adaptMessages(session: SessionV2Info, messages: SessionMessage[]) {
  const result: Array<{ info: Message; parts: Part[] }> = []
  let parentID: string | undefined

  for (const item of messages.toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))) {
    if (item.type === "user") {
      parentID = item.id
      result.push({
        info: {
          id: item.id,
          sessionID: session.id,
          role: "user",
          time: item.time,
          agent: session.agent ?? "build",
          model: {
            providerID: session.model?.providerID ?? "unknown",
            modelID: session.model?.id ?? "unknown",
            variant: session.model?.variant,
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
                  text: item.text,
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

    if (item.type === "assistant" && parentID) {
      result.push({
        info: {
          id: item.id,
          sessionID: session.id,
          role: "assistant",
          time: item.time,
          error: item.error ? { name: "UnknownError", data: { message: item.error.message } } : undefined,
          parentID,
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
        parts: item.content.map((content): Part => {
          if (content.type === "text") {
            return {
              id: content.id,
              sessionID: session.id,
              messageID: item.id,
              type: "text",
              text: content.text,
            }
          }
          if (content.type === "reasoning") {
            return {
              id: content.id,
              sessionID: session.id,
              messageID: item.id,
              type: "reasoning",
              text: content.text,
              metadata: content.providerMetadata,
              time: {
                start: content.time?.created ?? item.time.created,
                end: content.time?.completed,
              },
            }
          }
          return adaptTool(session.id, item.id, content)
        }),
      })
      continue
    }

    if (item.type !== "synthetic" && item.type !== "shell") continue
    parentID = item.id
    result.push({
      info: {
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
        },
      ],
    })
  }

  return result
}

function adaptTool(sessionID: string, messageID: string, tool: SessionMessageAssistantTool): Part {
  const content = tool.state.status === "pending" ? [] : tool.state.content
  const output = content
    .map((item) => (item.type === "text" ? item.text : `[${item.name ?? item.uri}](${item.uri})`))
    .join("\n\n")
  const input = tool.state.status === "pending" ? {} : tool.state.input
  const state = (() => {
    if (tool.state.status === "pending") return { status: "pending" as const, input, raw: tool.state.input }
    if (tool.state.status === "running") {
      return {
        status: "running" as const,
        input,
        title: tool.name,
        metadata: tool.state.structured,
        time: { start: tool.time.ran ?? tool.time.created },
      }
    }
    if (tool.state.status === "error") {
      return {
        status: "error" as const,
        input,
        error: tool.state.error.message,
        metadata: tool.state.structured,
        time: { start: tool.time.ran ?? tool.time.created, end: tool.time.completed ?? tool.time.created },
      }
    }
    return {
      status: "completed" as const,
      input,
      output,
      title: tool.name,
      metadata: tool.state.structured,
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
    id: tool.id,
    sessionID,
    messageID,
    type: "tool",
    callID: tool.id,
    tool: tool.name,
    state,
    metadata: tool.provider?.resultMetadata,
  }
}
