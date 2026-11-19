import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { HistoryPaused } from "./history-run"

export type CampaignLimit = { maxSends: number; maxTokens: number }
export type Usage = {
  input: number
  output: number
  total: number
  cachedInput: number | null
  reasoning: number | null
}
type Outcome = "in-flight" | "ok" | "retryable" | "rejected" | "invalid-output" | "uncertain"
type PhysicalSend = {
  id: string
  slot: string
  step: number
  attempt: number
  requestHash: string
  model: string
  route: string
  reserve: number
  outcome: Outcome
  status: number | null
  usage: string | null
  value: string | null
  started: number
  elapsed: number | null
  overOutput: number
}

export const whole = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

export async function withJournal<A>(
  root: string,
  limit: CampaignLimit,
  run: (journal: Journal, directory: string) => Promise<A>,
) {
  if (!path.isAbsolute(root) || !whole(limit.maxSends) || !whole(limit.maxTokens))
    throw new Error("invalid-authorized-campaign-limit")
  await mkdir(root, { recursive: true })
  const directory = await realpath(root)
  // The OS releases this independent writer lock on process exit, including a crash.
  const lock = new Database(path.join(directory, "writer.sqlite"))
  let db: Database | undefined
  try {
    lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE")
    db = new Database(path.join(directory, "ledger.sqlite"))
    const journal = new Journal(db, limit)
    return await run(journal, directory)
  } finally {
    try {
      db?.close()
    } finally {
      lock.close()
    }
  }
}

export class Journal {
  readonly nonce: string

  constructor(
    private readonly db: Database,
    readonly cap: CampaignLimit,
  ) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS manifest (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sends (
        id TEXT PRIMARY KEY, slot TEXT NOT NULL, step INTEGER NOT NULL, attempt INTEGER NOT NULL,
        requestHash TEXT NOT NULL, model TEXT NOT NULL, route TEXT NOT NULL,
        reserve INTEGER NOT NULL, outcome TEXT NOT NULL, status INTEGER,
        usage TEXT, value TEXT, started INTEGER NOT NULL, elapsed INTEGER, overOutput INTEGER NOT NULL DEFAULT 0, UNIQUE(slot, step, attempt)
      );
      CREATE TABLE IF NOT EXISTS invocations (
        id INTEGER PRIMARY KEY, started INTEGER NOT NULL, maxSends INTEGER NOT NULL, maxTokens INTEGER NOT NULL
      );
      UPDATE sends SET outcome = 'uncertain' WHERE outcome = 'in-flight';
    `)
    db.query("INSERT OR IGNORE INTO manifest VALUES ('nonce', ?)").run(randomUUID())
    this.nonce = db.query<{ value: string }, []>("SELECT value FROM manifest WHERE key = 'nonce'").get()!.value
    db.query("INSERT INTO invocations(started, maxSends, maxTokens) VALUES (?, ?, ?)").run(
      Date.now(),
      cap.maxSends,
      cap.maxTokens,
    )
  }

  bind(key: "generation" | "qa", hash: string) {
    this.db.query("INSERT OR IGNORE INTO manifest VALUES (?, ?)").run(key, hash)
    const saved = this.db.query<{ value: string }, [string]>("SELECT value FROM manifest WHERE key = ?").get(key)
    if (saved?.value !== hash) throw new Error("evaluation-input-or-route-plan-changed")
  }

  history(slot: string, step: number) {
    return this.db
      .query<PhysicalSend, [string, number]>("SELECT * FROM sends WHERE slot = ? AND step = ? ORDER BY attempt")
      .all(slot, step)
  }

  start(
    input: Pick<PhysicalSend, "slot" | "step" | "attempt" | "requestHash" | "model" | "route" | "reserve">,
    slotLimit: number,
  ) {
    const slot = this.db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM sends WHERE slot = ?")
      .get(input.slot)
    if (slot!.n >= slotLimit) throw new Error("slot-send-limit")
    const spent = this.totals()
    if (spent.overrun) throw new HistoryPaused("reservation-overrun")
    if (spent.sends >= this.cap.maxSends) throw new HistoryPaused("campaign-send-limit")
    if (spent.liability + input.reserve > this.cap.maxTokens) throw new HistoryPaused("campaign-token-limit")
    const id = randomUUID()
    const started = Date.now()
    this.db
      .query(
        `
      INSERT INTO sends(id, slot, step, attempt, requestHash, model, route, reserve, outcome, started)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in-flight', ?)
    `,
      )
      .run(
        id,
        input.slot,
        input.step,
        input.attempt,
        input.requestHash,
        input.model,
        input.route,
        input.reserve,
        started,
      )
    return { id, started }
  }

  finish(
    send: { id: string; started: number },
    result: {
      outcome: Exclude<Outcome, "in-flight">
      status?: number
      usage?: Usage
      value?: unknown
      overOutput?: boolean
    },
  ) {
    const row = this.db
      .query(
        `
      UPDATE sends SET outcome = ?, status = ?, usage = ?, value = ?, elapsed = ?, overOutput = ?
      WHERE id = ? AND outcome = 'in-flight'
    `,
      )
      .run(
        result.outcome,
        result.status ?? null,
        result.usage ? JSON.stringify(result.usage) : null,
        result.value === undefined ? null : JSON.stringify(result.value),
        Date.now() - send.started,
        result.overOutput ? 1 : 0,
        send.id,
      )
    if (row.changes !== 1) throw new Error("physical-send-settlement-conflict")
    const spent = this.totals()
    if (spent.overrun) throw new HistoryPaused("reservation-overrun")
    if (spent.liability > this.cap.maxTokens) throw new HistoryPaused("campaign-token-limit")
  }

  totals() {
    return this.db
      .query<
        {
          sends: number
          known: number
          unknown: number
          knownTokens: number
          unknownReserve: number
          liability: number
          overrun: number
        },
        []
      >(
        `
      SELECT count(*) AS sends,
        count(usage) AS known, count(*) - count(usage) AS unknown,
        coalesce(sum(json_extract(usage, '$.total')), 0) AS knownTokens,
        coalesce(sum(CASE WHEN usage IS NULL THEN reserve ELSE 0 END), 0) AS unknownReserve,
        coalesce(sum(coalesce(json_extract(usage, '$.total'), reserve)), 0) AS liability,
        coalesce(sum(CASE WHEN (json_extract(usage, '$.total') > reserve OR overOutput = 1) THEN 1 ELSE 0 END), 0) AS overrun
      FROM sends
    `,
      )
      .get()!
  }

  accounting() {
    const sends = this.db
      .query<Omit<PhysicalSend, "value">, []>(
        `
      SELECT id, slot, step, attempt, requestHash, model, route, reserve, outcome, status, usage, started, elapsed, overOutput
      FROM sends ORDER BY rowid
    `,
      )
      .all()
      .map((send) => ({ ...send, usage: send.usage ? (JSON.parse(send.usage) as Usage) : null }))
    return { cap: this.cap, totals: this.totals(), sends }
  }
}
