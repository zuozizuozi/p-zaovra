// Exports one session's durable events from a Zaovra database copy into a replay fixture.
//
//   bun test-replay/export.ts <database> <fixture.json> [sessionID]
//
// Structure survives (IDs, sequence numbers, types, timing, lengths); content does not. Every
// string that is not a short identifier becomes filler, so fixtures carry no conversation text,
// file content, paths or credentials and can live in the repository.
import { Database } from "bun:sqlite"

const [source, target, requested] = Bun.argv.slice(2)
if (!source || !target) throw new Error("Usage: bun test-replay/export.ts <database> <fixture.json> [sessionID]")

const db = new Database(source, { readonly: true })
// A session may be named by any prefix of its ID; the default is the session with the most events.
const sessionID = (
  db
    .query("select aggregate_id id from event where aggregate_id like ? group by aggregate_id order by count(*) desc")
    .get(`${requested ?? "ses_"}%`) as { id: string } | null
)?.id
if (!sessionID) throw new Error("No session events found")

const identifier = /^[A-Za-z0-9_.:\-/]{1,96}$/
const keep = 48

function scrub(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (identifier.test(value)) return value
    // Tool input arrives as one JSON string; keep it parseable so the reducer sees real shapes.
    if (key === "text" && value.startsWith("{")) {
      try {
        return JSON.stringify(scrub(JSON.parse(value)))
      } catch {}
    }
    return [...value.slice(0, keep)].map((char) => (char === "\n" ? "\n" : "x")).join("")
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item], index) => [
        identifier.test(name) ? name : `key${index}`,
        scrub(item, name),
      ]),
    )
  return value
}

const rows = db.query("select id, type, seq, data from event where aggregate_id = ? order by seq").all(sessionID) as {
  id: string
  type: string
  seq: number
  data: string
}[]

const events = rows.map((row) => {
  const data = JSON.parse(row.data) as Record<string, unknown>
  // Requested text length drives streaming chunks during replay; record it before scrubbing shortens it.
  const length = typeof data.text === "string" ? data.text.length : undefined
  return {
    id: row.id,
    type: row.type,
    seq: row.seq,
    ...(length === undefined ? {} : { length }),
    // Host diagnostics never reach the transcript; they only have to keep their place in the sequence.
    data: row.type.startsWith("session.next.quality.progress")
      ? { timestamp: data.timestamp, sessionID: data.sessionID, category: data.category, details: {} }
      : scrub(data),
  }
})

await Bun.write(target, JSON.stringify({ sessionID, events }) + "\n")
console.log(`${sessionID}: ${events.length} events -> ${target} (${(Bun.file(target).size / 1024).toFixed(0)} KB)`)
