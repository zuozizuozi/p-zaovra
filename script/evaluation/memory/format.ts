import { createHash } from "node:crypto"
import { lstat, open, readdir } from "node:fs/promises"
import path from "node:path"
import { chains } from "./cases"
import { completed, jsonFacts } from "./oracle"
import type { Result, Turn } from "./oracle"

type Verdict = "verified" | "violated" | "unknown"
type Artifact = Result & { name: string }

/** Grade the stopped, exclusively owned workspace and the host-selected own-turn answer.
 * The caller must bind both adapters to this stage's complete trace. Neither assistant
 * claims nor a partial tool list can manufacture a verified verdict. No model is called here.
 */
export async function gradeFormat(input: {
  directory: string
  stage: number
  turn: Turn
  answer?: string
  verifyAnswer?: (input: { stage: number; answer: string; requirements: readonly string[] }) => Promise<Verdict>
  verifyTools?: (input: {
    stage: number
    requirements: readonly string[]
    artifacts: readonly Artifact[]
  }) => Promise<Verdict>
}) {
  if (!Number.isInteger(input.stage) || input.stage < 1 || input.stage > 5) throw new Error("invalid-format-stage")
  const artifacts: Artifact[] = []
  if (!completed([input.turn], 1)) return { pass: false, reason: "session-not-completed", artifacts }
  const chain = chains.find((item) => item.id === "format")!
  const files = { "notes.txt": input.stage < 4 ? chain.seed["notes.txt"]! : chain.beforeFourth.write["notes.txt"]! }
  const facts = [
    ...(input.stage >= 3 ? [{ name: "answer.json", expected: { lines: input.stage < 4 ? 4 : 6 } }] : []),
    ...(input.stage === 5 ? [{ name: "history.json", expected: chain.history }] : []),
  ]
  const texts = { ...files, ...(input.stage >= 4 ? { ".memory-eval-fourth": "format" } : {}) }
  const names = Object.keys(texts).concat(facts.map((item) => item.name))
  try {
    for (const name of await readdir(input.directory)) {
      const stat = await lstat(path.join(input.directory, name))
      if (!names.includes(name) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        return { pass: false, reason: "unexpected-or-unsafe-workspace-artifact", artifacts }
    }
  } catch {
    return { pass: false, reason: "workspace-unavailable", artifacts }
  }
  for (const [name, expected] of Object.entries(texts)) {
    const content = await read(path.join(input.directory, name))
    artifacts.push({
      name,
      pass: content !== undefined && content.equals(Buffer.from(expected)),
      reason: content === undefined ? "artifact-unreadable-or-oversized" : "frozen-text-comparison",
      ...(content === undefined ? {} : { artifact: fingerprint(content) }),
    })
  }
  for (const fact of facts) {
    artifacts.push({
      name: fact.name,
      ...(await jsonFacts({ directory: input.directory, ...fact, turns: [input.turn], expectedTurns: 1 })),
    })
  }
  if (artifacts.some((item) => !item.pass)) return { pass: false, reason: "format-artifacts-differ", artifacts }
  const requirements = {
    answer:
      input.stage === 1
        ? ["one-sentence-report-of-exactly-four-lines"]
        : input.stage === 2
          ? ["english-acknowledgement"]
          : input.stage === 3
            ? ["english-report-of-exactly-four-lines"]
            : [],
    tools: [1, 3, 4].includes(input.stage) ? ["read-current-notes-in-this-stage"] : [],
  }
  if (typeof input.answer !== "string" || !input.answer.trim() || Buffer.byteLength(input.answer) > 16384)
    return { pass: false, reason: "needs-host-answer-evidence", artifacts, requirements }
  const answer = fingerprint(Buffer.from(input.answer))
  const prefix = input.stage >= 4 ? "结论：" : input.stage >= 2 ? "SUMMARY:" : undefined
  // Do not trim: an earlier line or a code fence is not the required first-line prefix.
  if (prefix && !input.answer.startsWith(prefix))
    return { pass: false, reason: "answer-prefix-differs", artifacts, answer, requirements }
  // Presence of '4'/'四', ASCII characters or SUMMARY alone does not prove a correct English answer.
  const meaning = requirements.answer.length
    ? await Promise.resolve()
        .then(() =>
          input.verifyAnswer?.({ stage: input.stage, answer: input.answer!, requirements: requirements.answer }),
        )
        .catch(() => "unknown")
    : "verified"
  if (meaning !== "verified")
    return {
      pass: false,
      reason: meaning === "violated" ? "host-answer-requirement-violated" : "needs-host-answer-evidence",
      artifacts,
      answer,
      requirements,
    }
  const tools = requirements.tools.length
    ? await Promise.resolve()
        .then(() => input.verifyTools?.({ stage: input.stage, requirements: requirements.tools, artifacts }))
        .catch(() => "unknown")
    : "verified"
  if (tools !== "verified")
    return {
      pass: false,
      reason: tools === "violated" ? "host-tool-requirement-violated" : "needs-host-tool-evidence",
      artifacts,
      answer,
      requirements,
    }
  return { pass: true, reason: "format-phase-matches", artifacts, answer, requirements }
}

function fingerprint(bytes: Uint8Array) {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }
}

async function read(file: string) {
  try {
    const handle = await open(file, "r")
    try {
      if (!(await handle.stat()).isFile()) return
      const bytes = Buffer.alloc(16385)
      let length = 0
      while (length < bytes.length) {
        const chunk = await handle.read(bytes, length, bytes.length - length, length)
        if (!chunk.bytesRead) break
        length += chunk.bytesRead
      }
      if (length > 16384) return
      return bytes.subarray(0, length)
    } finally {
      await handle.close()
    }
  } catch {
    return
  }
}
