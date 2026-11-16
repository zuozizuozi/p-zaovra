import { createHash } from "node:crypto"
import { lstat, open, readdir } from "node:fs/promises"
import path from "node:path"
import { chains } from "./cases"
import { arithmetic, completed, jsonFacts } from "./oracle"
import type { Result, Turn } from "./oracle"

type Artifact = Result & { name: string }

/** Host owns the stopped workspace. Behavioral checks execute fixture code in the caller's
 * isolated resource-limited Job, not a security sandbox. Tool requirements need separate
 * complete host evidence; passing hidden assertions is not proof the model ran its tests.
 */
export async function gradeArithmetic(input: {
  directory: string
  stage: number
  turn: Turn
  executable: string
  previousArtifacts?: readonly Artifact[]
  verifyTools?: (input: {
    stage: number
    requirements: readonly string[]
    artifacts: readonly Artifact[]
  }) => Promise<"verified" | "violated" | "unknown">
}) {
  if (!Number.isInteger(input.stage) || input.stage < 1 || input.stage > 5) throw new Error("invalid-arithmetic-stage")
  const artifacts: Artifact[] = []
  if (!completed([input.turn], 1)) return { pass: false, reason: "session-not-completed", artifacts }
  const chain = chains.find((item) => item.id === "arithmetic")!
  const test = input.stage < 4 ? "test/sum.test.cjs" : "test/math.test.cjs"
  const fixed = {
    "package.json": input.stage < 4 ? chain.seed["package.json"]! : chain.beforeFourth.write["package.json"]!,
    "README.md": input.stage < 4 ? chain.seed["README.md"]! : chain.beforeFourth.write["README.md"]!,
    ...(input.stage >= 4 ? { ".memory-eval-fourth": "arithmetic" } : {}),
  }
  const names = [...Object.keys(fixed), "src/sum.cjs", test, ...(input.stage === 5 ? ["history.json"] : [])]
  try {
    await inspect(input.directory, "", names)
    for (const name of names) {
      const bytes = await read(path.join(input.directory, name))
      const expected = fixed[name as keyof typeof fixed] ?? (input.stage <= 2 ? chain.seed[name] : undefined)
      const pass = bytes.length > 0 && (expected === undefined || bytes.equals(Buffer.from(expected)))
      artifacts.push({
        name,
        pass,
        reason: pass ? "phase-bytes-match" : "phase-bytes-differ",
        artifact: fingerprint(bytes),
      })
    }
  } catch {
    return { pass: false, reason: "unexpected-or-unsafe-artifact", artifacts }
  }
  if (artifacts.some((item) => !item.pass)) return { pass: false, reason: "arithmetic-artifacts-differ", artifacts }
  const current = (name: string) => artifacts.find((item) => item.name === name)!.artifact!.sha256
  const previous = (name: string) =>
    input.previousArtifacts?.find((item) => item.name === name && item.pass)?.artifact?.sha256
  if (input.stage === 3 && current(test) === fingerprint(Buffer.from(chain.seed[test]!)).sha256)
    return { pass: false, reason: "tests-not-extended", artifacts }
  if (input.stage === 4) {
    if (!previous("test/sum.test.cjs")) return { pass: false, reason: "needs-previous-stage-artifacts", artifacts }
    if (previous("test/sum.test.cjs") === current(test)) return { pass: false, reason: "tests-not-extended", artifacts }
  }
  if (input.stage === 5) {
    if (!["src/sum.cjs", test].every((name) => previous(name)))
      return { pass: false, reason: "needs-previous-stage-artifacts", artifacts }
    if (!["src/sum.cjs", test].every((name) => previous(name) === current(name)))
      return { pass: false, reason: "history-phase-changed-code", artifacts }
    const history = await jsonFacts({
      directory: input.directory,
      name: "history.json",
      expected: chain.history,
      turns: [input.turn],
      expectedTurns: 1,
    })
    if (!history.pass) return { pass: false, reason: history.reason, artifacts }
  }
  if (input.stage === 3 || input.stage === 4) {
    const behavior = await arithmetic({
      directory: input.directory,
      executable: input.executable,
      turns: [input.turn],
      expectedTurns: 1,
      subtract: input.stage === 4,
    })
    if (!behavior.pass) return { pass: false, reason: behavior.reason, artifacts }
    // Detect fixture mutation by evaluated code; this is not an OS sandbox or transient-write proof.
    try {
      await inspect(input.directory, "", names)
      for (const name of names)
        if (fingerprint(await read(path.join(input.directory, name))).sha256 !== current(name))
          return { pass: false, reason: "artifact-changed-during-oracle", artifacts }
    } catch {
      return { pass: false, reason: "artifact-changed-during-oracle", artifacts }
    }
  }
  const requirements = [
    ["existing-node-tests-executed-successfully", "no-dependency-install"],
    [],
    ["direct-node-current-tests-succeeded", "added-tests-exercise-mul", "no-npm-test", "no-dependency-install"],
    [
      "read-updated-test-and-package",
      "npm-run-check-succeeded",
      "added-tests-exercise-sub",
      "no-old-direct-node-command",
      "no-dependency-install",
    ],
    [],
  ][input.stage - 1]!
  const tools = requirements.length
    ? await Promise.resolve()
        .then(() => input.verifyTools?.({ stage: input.stage, requirements, artifacts }))
        .catch(() => "unknown")
    : "verified"
  if (tools !== "verified")
    return {
      pass: false,
      reason: tools === "violated" ? "host-tool-requirement-violated" : "needs-host-tool-evidence",
      artifacts,
      requirements,
    }
  return { pass: true, reason: "arithmetic-phase-matches", artifacts, requirements }
}

function fingerprint(bytes: Uint8Array) {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }
}

async function inspect(root: string, directory: string, names: readonly string[]): Promise<void> {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const name = directory ? `${directory}/${entry.name}` : entry.name
    const stat = await lstat(path.join(root, name))
    if (stat.isSymbolicLink()) throw new Error("artifact-link")
    if (stat.isDirectory() && names.some((item) => item.startsWith(`${name}/`))) {
      await inspect(root, name, names)
      continue
    }
    if (!stat.isFile() || stat.nlink !== 1 || !names.includes(name)) throw new Error("unexpected-artifact")
  }
}

async function read(file: string) {
  const handle = await open(file, "r")
  try {
    if (!(await handle.stat()).isFile()) throw new Error("not-a-file")
    const bytes = Buffer.alloc(16385)
    let length = 0
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, length)
      if (!chunk.bytesRead) break
      length += chunk.bytesRead
    }
    if (length > 16384) throw new Error("artifact-too-large")
    return bytes.subarray(0, length)
  } finally {
    await handle.close()
  }
}
