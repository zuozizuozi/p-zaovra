import type { Message, Part, SessionStatus } from "@zaovra-ai/sdk/v2"

/** Pending inputs have no provider turn yet. Older unfinished history cannot claim a newer promoted turn. */
export function activeTurnMessage(
  messages: readonly Message[],
  parts: (id: string) => readonly Part[],
  status: SessionStatus,
  pending?: (id: string) => boolean,
) {
  if (status.type === "idle") return
  const chronological = messages.toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
  const current = chronological.findLast(
    (message) =>
      message.role === "user" &&
      !(pending
        ? pending(message.id)
        : parts(message.id).some((part) => part.type === "text" && part.metadata?.zaovraDelivery)),
  )
  if (!current) return
  const latest = chronological.findLast((message) => message.role === "assistant" && message.parentID === current.id)
  // While a retry is pending the kernel will send the request again: the failed step did not end the turn.
  if (
    status.type !== "retry" &&
    latest?.role === "assistant" &&
    typeof latest.time.completed === "number" &&
    latest.finish !== "tool-calls"
  )
    return
  return current.id
}

export function pendingTurnLabel(delivery: unknown, active: string | undefined, messageID: string) {
  if (delivery === "queue") return "session.message.queued"
  if (delivery !== "steer") return
  return active && active !== messageID ? "session.message.waitingToJoin" : "session.message.waitingToStart"
}

export function isContinuation(parts: readonly Part[]) {
  return (
    parts.length > 0 &&
    parts.every(
      (part) => part.type === "step-start" || part.type === "compaction" || (part.type === "text" && part.synthetic),
    )
  )
}

/** Display ownership only. The store remains ID-sorted for binary lookup. */
export function displayTurnOwners(messages: readonly Message[], parts: (id: string) => readonly Part[]) {
  const byID = new Map(messages.map((message) => [message.id, message]))
  const users = messages
    .filter((message) => message.role === "user")
    .toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
  const fallback = new Map<string, string | undefined>()
  const previous = new Map<string, string | undefined>()
  for (let start = 0; start < users.length; ) {
    let end = start + 1
    while (end < users.length && users[end].time.created === users[start].time.created) end++
    const group = users.slice(start, end)
    const sessions = new Map<string, typeof group>()
    group.forEach((message) => {
      const batch = sessions.get(message.sessionID)
      if (batch) batch.push(message)
      if (!batch) sessions.set(message.sessionID, [message])
    })
    sessions.forEach((batch, sessionID) => {
      const missing = batch.some((message) => parts(message.id).length === 0)
      const human = batch.filter((message) => parts(message.id).length > 0 && !isContinuation(parts(message.id)))
      batch.forEach((message) =>
        fallback.set(message.id, human.length || missing ? undefined : previous.get(sessionID)),
      )
      if (missing || human.length) previous.set(sessionID, !missing && human.length === 1 ? human[0].id : undefined)
    })
    start = end
  }
  const owners = new Map<string, string>()
  const resolve = (id: string, visited: Set<string>): string | undefined => {
    if (owners.has(id)) return owners.get(id)
    if (visited.has(id)) return
    visited.add(id)
    const message = byID.get(id)
    if (!message) return
    if (message.role === "assistant") return resolve(message.parentID, visited)
    if (!isContinuation(parts(id))) return id
    // The kernel records which user message a shell record or notice was produced for. Older
    // history has no such record and is placed by the rules below.
    const turn = parts(id).flatMap((part) =>
      part.type === "text" && typeof part.metadata?.zaovraTurn === "string" ? [part.metadata.zaovraTurn] : [],
    )[0]
    if (turn && turn !== id && byID.get(turn)?.sessionID === message.sessionID) return resolve(turn, visited)
    const source = parts(id).flatMap((part) =>
      part.type === "text" && typeof part.metadata?.zaovraSourceMessageID === "string"
        ? [part.metadata.zaovraSourceMessageID]
        : [],
    )[0]
    // A missing explicit source (pagination/reconnect) must not borrow a newer human turn.
    return source
      ? byID.get(source)?.sessionID === message.sessionID
        ? resolve(source, visited)
        : undefined
      : fallback.get(id)
  }
  users.forEach((message) => owners.set(message.id, resolve(message.id, new Set()) ?? message.id))
  return owners
}
