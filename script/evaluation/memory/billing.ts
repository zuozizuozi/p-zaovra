import { chains } from "./cases"
import { readdir } from "node:fs/promises"
import { completed, jsonFacts } from "./oracle"
import type { Turn } from "./oracle"

/** Grade every phase while its owned backend tree is stopped, before later phases can overwrite it. */
export async function gradeBilling(input: { directory: string; stage: number; turn: Turn }) {
  if (!Number.isInteger(input.stage) || input.stage < 1 || input.stage > 5) throw new Error("invalid-billing-stage")
  if (!completed([input.turn], 1)) return { pass: false, reason: "session-not-completed", artifacts: [] }
  const expected = input.stage < 4 ? { timeout: 45, retries: 2 } : { timeout: 20, retries: 0 }
  const checks = [
    { name: "config.json", expected },
    { name: "contract.json", expected: { maximumTimeout: input.stage < 4 ? 60 : 20 } },
    ...(input.stage >= 3 ? [{ name: "secondary.json", expected }] : []),
    ...(input.stage === 5
      ? [{ name: "history.json", expected: chains.find((chain) => chain.id === "billing")!.history }]
      : []),
  ]
  const allowed = checks.map((check) => check.name).concat(input.stage >= 4 ? [".memory-eval-fourth"] : [])
  const entries = await readdir(input.directory, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile() || !allowed.includes(entry.name)))
    return { pass: false, reason: "unexpected-workspace-artifact", artifacts: [] }
  const artifacts = await Promise.all(
    checks.map(async (check) => ({
      name: check.name,
      ...(await jsonFacts({
        directory: input.directory,
        name: check.name,
        expected: check.expected,
        turns: [input.turn],
        expectedTurns: 1,
      })),
    })),
  )
  const pass = artifacts.every((result) => result.pass)
  return { pass, reason: pass ? "billing-phase-matches" : "billing-artifacts-differ", artifacts }
}
