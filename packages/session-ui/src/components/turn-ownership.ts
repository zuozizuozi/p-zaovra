import type { Message, Part } from "@zaovra-ai/sdk/v2"

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
