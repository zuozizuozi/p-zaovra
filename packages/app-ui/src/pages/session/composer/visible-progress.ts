import type { Message, Part } from "@zaovra-ai/sdk/v2/client"
import { displayTurnOwners, isContinuation } from "@zaovra-ai/session-ui/turn-ownership"
import { recoveredToolFailures } from "@zaovra-ai/session-ui/tool-recovery"

export function visibleProgress(input: {
  sessionID: string
  messages: readonly Message[]
  parts: Readonly<Record<string, Part[]>>
  busy: boolean
  liveShell?: Readonly<Record<string, true>>
  transportConnected?: boolean
  waiting: boolean
}) {
  const messages = input.messages
    .filter((message) => message.sessionID === input.sessionID)
    .toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
  // Adapted synthetic/shell rows are user-shaped but keep the preceding request's ownership.
  const owners = displayTurnOwners(messages, (id) => input.parts[id] ?? [])
  const request = messages.findLast(
    (message) => message.role === "user" && !isContinuation(input.parts[message.id] ?? []),
  )?.id
  const assistant = messages.findLast((message) => message.role === "assistant")
  const owner = assistant ? owners.get(assistant.parentID) : request
  const user = messages.find((message) => message.role === "user" && message.id === owner)
  const current = messages.filter(
    (message) => message.role === "assistant" && owner !== undefined && owners.get(message.parentID) === owner,
  )
  const parts = current.flatMap((message) => input.parts[message.id] ?? [])
  const tools = parts.filter((part) => part.type === "tool")
  const active = tools.findLast((part) => part.state.status === "running" || part.state.status === "pending")
  const recovered =
    assistant?.role === "assistant"
      ? recoveredToolFailures({
          message: assistant,
          messages,
          parts: input.parts,
          working: input.busy || input.waiting,
        })
      : []
  const failed = tools.filter((part) => part.state.status === "error" && !recovered.some((item) => item.id === part.id))
  const returned = tools.findLast((part) => part.state.status === "completed")
  const error = current.some((message) => message.role === "assistant" && !!message.error)
  const kinds = new Map<string, string>()
  const jobs = new Map<string, string>()
  for (const part of messages.flatMap((message) => input.parts[message.id] ?? [])) {
    if (part.type !== "tool" || part.state.status !== "completed") continue
    const metadata = part.state.metadata
    if (part.tool === "bash" && typeof metadata.job_id === "string") {
      jobs.set(metadata.job_id, "running")
      kinds.set(metadata.job_id, part.state.input.background_kind === "preview" ? "preview" : "task")
    }
    if (
      part.tool === "bash_job" &&
      typeof part.state.input.job_id === "string" &&
      typeof metadata.status === "string"
    ) {
      jobs.set(part.state.input.job_id, metadata.status)
      if (typeof metadata.kind === "string") kinds.set(part.state.input.job_id, metadata.kind)
    }
  }
  // Persisted completion is authoritative even when no later poll exists or a poll is stale.
  for (const message of messages) {
    for (const part of input.parts[message.id] ?? []) {
      if (
        part.type === "text" &&
        typeof part.metadata?.zaovraShellJobID === "string" &&
        !jobs.has(part.metadata.zaovraShellJobID)
      )
        jobs.set(part.metadata.zaovraShellJobID, "running")
      if (
        part.type === "text" &&
        typeof part.metadata?.zaovraShellJobID === "string" &&
        typeof part.metadata.zaovraShellCompleted === "number"
      )
        jobs.set(part.metadata.zaovraShellJobID, "finished")
    }
  }
  const pending = [...jobs].filter(([, status]) => status === "running" || status === "unavailable")
  const liveShell = input.transportConnected === false ? undefined : input.liveShell
  const unknown = pending.some(([id]) => !liveShell?.[id])
  const pendingJob = pending.some(([id]) => liveShell?.[id] && kinds.get(id) !== "preview")
  const preview = pending.some(([id]) => liveShell?.[id] && kinds.get(id) === "preview")
  const target = (user ? (input.parts[user.id] ?? []) : []).find((part) => part.type === "text")
  return {
    target: target?.type === "text" ? target.text.slice(0, 160) : "",
    state:
      input.transportConnected === false && (input.busy || input.waiting || active || pending.length)
        ? "disconnected"
        : input.waiting
          ? "waiting"
          : error
            ? "blocked"
            : unknown || (!input.busy && active)
              ? "unverified"
              : active || pendingJob
                ? "tool"
                : input.busy
                  ? "running"
                  : "idle",
    preview,
    updating:
      input.transportConnected !== false &&
      !unknown &&
      !error &&
      (input.busy || !active || input.waiting) &&
      (input.busy || input.waiting || !!active || pendingJob),
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
    visible: input.busy || input.waiting || !!active || unknown || pendingJob || preview,
  } as const
}
