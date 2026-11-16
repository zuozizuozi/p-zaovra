import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { open, realpath } from "node:fs/promises"
import path from "node:path"

/** Host observations only: never construct these fields from an assistant's answer. */
export interface Turn {
  admitted: boolean
  promoted: boolean
  active: boolean
  pending: number
  assistants: number
  unsettled: number
  outcome: "completed" | "failed" | "stopped" | "timeout" | "unknown"
}

export function completed(turns: ReadonlyArray<Turn>, expected: number) {
  return (
    Number.isSafeInteger(expected) &&
    expected > 0 &&
    turns.length === expected &&
    turns.every(
      (turn) =>
        turn.admitted === true &&
        turn.promoted === true &&
        turn.active === false &&
        turn.pending === 0 &&
        Number.isSafeInteger(turn.assistants) &&
        turn.assistants > 0 &&
        turn.unsettled === 0 &&
        turn.outcome === "completed",
    )
  )
}

export interface Result {
  pass: boolean
  reason: string
}

/** Resolve fixed evaluator-owned names; do not follow an artifact out of the fixture. */
async function artifact(directory: string, name: string) {
  const root = await realpath(directory)
  const file = await realpath(path.join(root, name))
  const relative = path.relative(root, file)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("artifact-outside-fixture")
  return file
}

/** Execute behavior, not a search for the string 'mul' in source or in an answer. */
export async function arithmetic(input: {
  directory: string
  executable: string
  turns: ReadonlyArray<Turn>
  expectedTurns: number
  subtract: boolean
}): Promise<Result> {
  if (!completed(input.turns, input.expectedTurns)) return { pass: false, reason: "session-not-completed" }
  try {
    const file = await artifact(input.directory, "src/sum.cjs")
    const marker = `oracle-complete:${randomUUID()}\n`
    const output = execFileSync(
      input.executable,
      [
        "-e",
        [
          'const assert = require("node:assert/strict")',
          `const app = require(${JSON.stringify(file)})`,
          "for (const [a, b] of [[2,3],[-2,3],[0,7],[0.5,4],[-3,-4]]) {",
          "assert.equal(app.add(a,b), a+b)",
          "assert.equal(app.mul(a,b), a*b)",
          ...(input.subtract ? ["assert.equal(app.sub(a,b), a-b)"] : []),
          "}",
          `process.stdout.write(${JSON.stringify(marker)})`,
        ].join("\n"),
      ],
      {
        cwd: input.directory,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        // No model credentials, NODE_OPTIONS, loaders or provider environment.
        env: {
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
          ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    if (!output.toString("utf8").endsWith(marker)) return { pass: false, reason: "assertions-not-completed" }
    return { pass: true, reason: "behavior-assertions-passed" }
  } catch {
    // Do not echo a project-controlled exception/child output into the report.
    return { pass: false, reason: "artifact-or-behavior-failed" }
  }
}

/** Exact historical facts, not the presence of a generic word such as 'slow'. */
export async function billingHistory(input: {
  directory: string
  turns: ReadonlyArray<Turn>
  expectedTurns: number
}): Promise<Result> {
  if (!completed(input.turns, input.expectedTurns)) return { pass: false, reason: "session-not-completed" }
  try {
    const file = await open(await artifact(input.directory, "history.json"), "r")
    const text = await (async () => {
      try {
        const bytes = Buffer.alloc(16 * 1024 + 1)
        const result = await file.read(bytes, 0, bytes.length, 0)
        if (result.bytesRead > 16 * 1024) throw new Error("history-too-large")
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, result.bytesRead))
      } finally {
        await file.close()
      }
    })()
    const value: unknown = JSON.parse(text)
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return { pass: false, reason: "history-not-object" }
    const fields = value as Record<string, unknown>
    const pass =
      fields.service === "billing" &&
      fields.symptom === "upstream_timeout" &&
      fields.previousSeconds === 30 &&
      fields.chosenSeconds === 45 &&
      fields.retryRisk === "duplicate_charge"
    return { pass, reason: pass ? "historical-facts-match" : "historical-facts-differ" }
  } catch {
    return { pass: false, reason: "history-artifact-invalid" }
  }
}
