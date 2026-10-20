import type { Message, Part } from "@zaovra-ai/sdk/v2/client"
import { hasUnfinishedShell } from "@/context/v2-session-adapter"

export function visibleProgress(input: {
  sessionID: string
  messages: readonly Message[]
  parts: Readonly<Record<string, Part[]>>
  busy: boolean
  waiting: boolean
}) {
  const messages = input.messages.filter((message) => message.sessionID === input.sessionID)
  const assistant = messages.findLast((message) => message.role === "assistant")
  const user = messages.findLast(
    (message) => message.role === "user" && (!assistant || message.id === assistant.parentID),
  )
  const current = messages.filter((message) => message.role === "assistant" && message.parentID === user?.id)
  const parts = current.flatMap((message) => input.parts[message.id] ?? [])
  const tools = parts.filter((part) => part.type === "tool")
  const active = tools.findLast((part) => part.state.status === "running" || part.state.status === "pending")
  const failed = tools.filter((part) => part.state.status === "error")
  const returned = tools.findLast((part) => part.state.status === "completed")
  const error = current.some((message) => message.role === "assistant" && !!message.error)
  const unfinished = hasUnfinishedShell(messages, input.parts)
  const jobs = new Map<string, string>()
  for (const part of messages.flatMap((message) => input.parts[message.id] ?? [])) {
    if (part.type !== "tool" || part.state.status !== "completed") continue
    const metadata = part.state.metadata
    if (part.tool === "bash" && typeof metadata.job_id === "string") jobs.set(metadata.job_id, "running")
    if (
      part.tool === "bash_job" &&
      typeof part.state.input.job_id === "string" &&
      typeof metadata.status === "string"
    ) {
      jobs.set(part.state.input.job_id, metadata.status)
    }
  }
  const pendingJob = [...jobs.values()].some((status) => status === "running" || status === "unavailable")
  const target = (user ? (input.parts[user.id] ?? []) : []).find((part) => part.type === "text")
  return {
    target: target?.type === "text" ? target.text.slice(0, 160) : "",
    state: input.waiting
      ? "waiting"
      : error
        ? "blocked"
        : active || unfinished || pendingJob
          ? "tool"
          : input.busy
            ? "running"
            : "idle",
    tool: active?.tool,
    fact: returned?.tool,
    facts: tools
      .filter((part) => part.state.status === "completed")
      .map((part) => ({
        id: part.id,
        tool: part.tool,
        duration:
          part.state.status === "completed" ? Math.max(0, part.state.time.end - part.state.time.start) : undefined,
      })),
    failures: failed.map((part) => ({
      id: part.id,
      tool: part.tool,
      error: part.state.status === "error" ? part.state.error : "",
    })),
    // A returned tool is a fact, never a completion or verification verdict.
    visible: input.busy || input.waiting || !!active || unfinished || pendingJob,
  } as const
}
