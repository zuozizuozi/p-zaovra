import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { arithmetic, billingHistory, completed } from "../../../script/evaluation/memory/oracle"
import { tmpdir } from "./fixture/tmpdir"

const done = {
  admitted: true,
  promoted: true,
  active: false,
  pending: 0,
  assistants: 2,
  unsettled: 0,
  outcome: "completed" as const,
}

test("evaluation cannot turn timeout, partial history or stale idle into success", () => {
  expect(completed([done], 1)).toBe(true)
  expect(completed([done], 2)).toBe(false)
  expect(completed([], 0)).toBe(false)
  for (const item of [
    { ...done, admitted: false },
    { ...done, promoted: false },
    { ...done, active: true },
    { ...done, pending: 1 },
    { ...done, unsettled: 1 },
    { ...done, assistants: 0 },
    { ...done, outcome: "timeout" as const },
    { ...done, outcome: "stopped" as const },
    { ...done, outcome: "failed" as const },
  ])
    expect(completed([done, item], 2)).toBe(false)
})

test("arithmetic verdict runs actual negative/zero/fraction behaviors, not source words", async () => {
  await using temp = await tmpdir()
  await mkdir(path.join(temp.path, "src"))
  const file = path.join(temp.path, "src/sum.cjs")
  const input = { directory: temp.path, executable: process.execPath, turns: [done], expectedTurns: 1, subtract: false }
  await writeFile(file, "exports.add = (a,b) => a+b; // mul is implemented and all tests pass\n")
  expect((await arithmetic(input)).pass).toBe(false)
  await writeFile(file, "process.exit(0)\n")
  expect((await arithmetic(input)).reason).toBe("assertions-not-completed")
  await writeFile(file, "exports.add = (a,b) => a+b; exports.mul = (a,b) => a+b\n")
  expect((await arithmetic(input)).pass).toBe(false)
  await writeFile(file, "exports.add = (a,b) => a+b; exports.mul = (a,b) => a*b\n")
  expect((await arithmetic(input)).pass).toBe(true)
  expect((await arithmetic({ ...input, subtract: true })).pass).toBe(false)
  await writeFile(file, "exports.add = (a,b) => a+b; exports.mul = (a,b) => a*b; exports.sub = (a,b) => a-b\n")
  expect((await arithmetic({ ...input, subtract: true })).pass).toBe(true)
  expect((await arithmetic({ ...input, turns: [{ ...done, outcome: "timeout" }] })).reason).toBe(
    "session-not-completed",
  )
})

test("historical verdict requires all frozen facts and a completed own session", async () => {
  await using temp = await tmpdir()
  const file = path.join(temp.path, "history.json")
  const input = { directory: temp.path, turns: [done], expectedTurns: 1 }
  await writeFile(file, JSON.stringify({ answer: "the upstream billing API was slow" }))
  expect((await billingHistory(input)).pass).toBe(false)
  const facts = {
    service: "billing",
    symptom: "upstream_timeout",
    previousSeconds: 30,
    chosenSeconds: 45,
    retryRisk: "duplicate_charge",
  }
  await writeFile(file, JSON.stringify({ ...facts, chosenSeconds: 20 }))
  expect((await billingHistory(input)).pass).toBe(false)
  await writeFile(file, JSON.stringify(facts))
  expect((await billingHistory(input)).pass).toBe(true)
  expect((await billingHistory({ ...input, turns: [{ ...done, outcome: "timeout" }] })).pass).toBe(false)
  await writeFile(file, "not-json billing slow")
  expect((await billingHistory(input)).reason).toBe("history-artifact-invalid")
  await writeFile(file, " ".repeat(16 * 1024) + JSON.stringify(facts))
  expect((await billingHistory(input)).reason).toBe("history-artifact-invalid")
})
