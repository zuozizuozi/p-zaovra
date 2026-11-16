import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { gradeBilling } from "../../../script/evaluation/memory/billing"
import { chains, prepare, change } from "../../../script/evaluation/memory/cases"
import { tmpdir } from "./fixture/tmpdir"

const turn = {
  admitted: true,
  promoted: true,
  active: false,
  pending: 0,
  assistants: 1,
  unsettled: 0,
  outcome: "completed" as const,
}

test("billing grades each frozen phase, including stale-memory conflict and precise history", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  await prepare(directory, "billing")
  const grade = (stage: number) => gradeBilling({ directory, stage, turn })
  expect((await grade(1)).pass).toBe(false)
  await writeFile(path.join(directory, "config.json"), JSON.stringify({ timeout: 45, retries: 2 }))
  const first = await grade(1)
  expect(first.pass).toBe(true)
  expect(first.artifacts.find((entry) => entry.name === "config.json")?.artifact).toEqual({
    sha256: createHash("sha256")
      .update(JSON.stringify({ timeout: 45, retries: 2 }))
      .digest("hex"),
    bytes: Buffer.byteLength(JSON.stringify({ timeout: 45, retries: 2 })),
  })
  expect((await grade(2)).pass).toBe(true)
  await writeFile(path.join(directory, "reason.txt"), "The user asked not to write this reason into the repository.")
  expect((await grade(2)).reason).toBe("unexpected-workspace-artifact")
  await unlink(path.join(directory, "reason.txt"))
  expect((await grade(3)).pass).toBe(false)
  await writeFile(path.join(directory, "secondary.json"), JSON.stringify({ timeout: 45, retries: 2 }))
  expect((await grade(3)).pass).toBe(true)
  await change(directory, "billing")
  expect((await grade(4)).pass).toBe(false)
  for (const name of ["config.json", "secondary.json"])
    await writeFile(path.join(directory, name), JSON.stringify({ timeout: 20, retries: 0 }))
  expect((await grade(4)).pass).toBe(true)
  expect((await grade(5)).pass).toBe(false)
  const history = chains.find((chain) => chain.id === "billing")!.history
  await writeFile(path.join(directory, "history.json"), JSON.stringify({ ...history, chosenSeconds: 20 }))
  expect((await grade(5)).pass).toBe(false)
  await writeFile(path.join(directory, "history.json"), JSON.stringify(history))
  expect((await grade(5)).pass).toBe(true)
  await writeFile(path.join(directory, "config.json"), JSON.stringify({ timeout: 45, retries: 9 }))
  expect((await grade(5)).pass).toBe(false)
})

test("billing refuses incomplete turns, extra JSON fields, wrong types and oversized artifacts", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  await prepare(directory, "billing")
  const file = path.join(directory, "config.json")
  await writeFile(file, JSON.stringify({ timeout: 45, retries: 2 }))
  for (const outcome of ["failed", "stopped", "timeout", "unknown"] as const)
    expect((await gradeBilling({ directory, stage: 1, turn: { ...turn, outcome } })).reason).toBe(
      "session-not-completed",
    )
  for (const value of [{ timeout: "45", retries: 2 }, { timeout: 45, retries: 2, pass: true }, { timeout: 45 }]) {
    await writeFile(file, JSON.stringify(value))
    expect((await gradeBilling({ directory, stage: 1, turn })).pass).toBe(false)
  }
  await writeFile(file, " ".repeat(16384) + JSON.stringify({ timeout: 45, retries: 2 }))
  expect((await gradeBilling({ directory, stage: 1, turn })).pass).toBe(false)
  await expect(gradeBilling({ directory, stage: 6, turn })).rejects.toThrow("invalid-billing-stage")
})
