import { expect, test } from "bun:test"
import { link, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { chains, change, prepare } from "../../../script/evaluation/memory/cases"
import { historicalFacts } from "../../../script/evaluation/memory/oracle"
import { tmpdir } from "./fixture/tmpdir"

test("five independent seeds expose task files but not host answer keys", async () => {
  await using temp = await tmpdir()
  expect(chains.map((chain) => chain.id)).toEqual(["arithmetic", "format", "build", "billing", "publish"])
  for (const chain of chains) {
    const directory = path.join(temp.path, chain.id)
    await prepare(directory, chain.id)
    expect(chain.prompts).toHaveLength(5)
    for (const [name, content] of Object.entries(chain.seed))
      expect(await readFile(path.join(directory, name), "utf8")).toBe(content)
    expect(await readdir(directory)).not.toContain("history.json")
    await expect(prepare(directory, chain.id)).rejects.toThrow()
    await change(directory, chain.id)
    for (const [from, to] of chain.beforeFourth.rename) {
      await expect(lstat(path.join(directory, from))).rejects.toThrow()
      expect((await lstat(path.join(directory, to))).isFile()).toBe(true)
    }
    for (const [name, content] of Object.entries(chain.beforeFourth.write))
      expect(await readFile(path.join(directory, name), "utf8")).toBe(content)
    await expect(change(directory, chain.id)).rejects.toThrow("fixture-destination-exists")
  }
})

test("changing fixtures preserves model work and rejects destination collisions without partial writes", async () => {
  await using temp = await tmpdir()
  const directory = path.join(temp.path, "arithmetic")
  await prepare(directory, "arithmetic")
  const implementation = "exports.add=(a,b)=>a+b; exports.mul=(a,b)=>a*b\n"
  await writeFile(path.join(directory, "src/sum.cjs"), implementation)
  await writeFile(path.join(directory, "test/sum.test.cjs"), "model-added-tests")
  await writeFile(path.join(directory, "test/math.test.cjs"), "existing-model-file")
  await expect(change(directory, "arithmetic")).rejects.toThrow("fixture-destination-exists")
  expect(await readFile(path.join(directory, "test/math.test.cjs"), "utf8")).toBe("existing-model-file")
  await expect(lstat(path.join(directory, ".memory-eval-fourth"))).rejects.toThrow()
  await unlink(path.join(directory, "test/math.test.cjs"))
  await change(directory, "arithmetic")
  expect(await readFile(path.join(directory, "test/math.test.cjs"), "utf8")).toBe("model-added-tests")
  expect(await readFile(path.join(directory, "src/sum.cjs"), "utf8")).toBe(implementation)
})

test("fixture host edits refuse hard-linked model files rather than modifying an outside object", async () => {
  await using temp = await tmpdir()
  const directory = path.join(temp.path, "billing")
  await prepare(directory, "billing")
  const outside = path.join(temp.path, "outside.json")
  await writeFile(outside, "outside-original")
  await unlink(path.join(directory, "contract.json"))
  await link(outside, path.join(directory, "contract.json"))
  await expect(change(directory, "billing")).rejects.toThrow("fixture-path-not-ordinary")
  expect(await readFile(outside, "utf8")).toBe("outside-original")
  await expect(lstat(path.join(directory, ".memory-eval-fourth"))).rejects.toThrow()
})

test("fixture host edits refuse a redirected parent directory", async () => {
  await using temp = await tmpdir()
  const directory = path.join(temp.path, "arithmetic")
  await prepare(directory, "arithmetic")
  const outside = path.join(temp.path, "outside")
  await mkdir(outside)
  await writeFile(path.join(outside, "sum.test.cjs"), "outside-original")
  // Preserve the seeded directory; move it aside before replacing it with a junction.
  const { rename } = await import("node:fs/promises")
  await rename(path.join(directory, "test"), path.join(directory, "saved-test"))
  await symlink(outside, path.join(directory, "test"), process.platform === "win32" ? "junction" : "dir")
  try {
    await expect(change(directory, "arithmetic")).rejects.toThrow("fixture-path-not-ordinary")
    expect(await readFile(path.join(outside, "sum.test.cjs"), "utf8")).toBe("outside-original")
    await expect(lstat(path.join(outside, "math.test.cjs"))).rejects.toThrow()
  } finally {
    await unlink(path.join(directory, "test"))
  }
})

test("unknown case never creates a workspace", async () => {
  await using temp = await tmpdir()
  const directory = path.join(temp.path, "unknown")
  await expect(prepare(directory, "no-such-case")).rejects.toThrow("unknown-memory-chain")
  await expect(lstat(directory)).rejects.toThrow()
})

test("each chain's historical facts require exact host fields, not keywords or current values", async () => {
  await using temp = await tmpdir()
  const done = {
    admitted: true,
    promoted: true,
    active: false,
    pending: 0,
    assistants: 1,
    unsettled: 0,
    outcome: "completed" as const,
  }
  for (const chain of chains) {
    const directory = path.join(temp.path, chain.id)
    await prepare(directory, chain.id)
    const file = path.join(directory, "history.json")
    const input = { directory, turns: [done], expectedTurns: 1, expected: chain.history }
    await writeFile(file, JSON.stringify(chain.history))
    expect((await historicalFacts(input)).pass).toBe(true)
    expect((await historicalFacts({ ...input, turns: [{ ...done, outcome: "timeout" }] })).pass).toBe(false)
    await writeFile(file, JSON.stringify({ ...chain.history, answer: "all facts are correct" }))
    expect((await historicalFacts(input)).pass).toBe(false)
    const first = Object.keys(chain.history)[0]!
    await writeFile(file, JSON.stringify({ ...chain.history, [first]: "wrong" }))
    expect((await historicalFacts(input)).pass).toBe(false)
  }
})
