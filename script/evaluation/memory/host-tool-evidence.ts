import path from "node:path"
import { applyPatch, parsePatch } from "diff"
import { Option, Schema } from "effect"
import { Entry, Match } from "@zaovra-ai/schema/filesystem"
import { FileDiff } from "@zaovra-ai/schema/file-diff"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { Patch } from "@zaovra-ai/core/patch"
import type { TurnEvidence } from "./observe"

type Tool = Extract<TurnEvidence, { status: "complete" }>["tools"][number]
const searchFields = { truncated: Schema.Boolean, partial: Schema.Boolean, skippedRecords: Schema.Number }
const listing = Schema.Struct({ entries: Schema.Array(Entry), truncated: Schema.Boolean })
const glob = Schema.Struct({ entries: Schema.Array(Entry), ...searchFields })
const grep = Schema.Struct({ matches: Schema.Array(Match), ...searchFields })
const receipt = Schema.Struct({
  applied: Schema.Array(
    Schema.Struct({
      type: Schema.Literals(["add", "update", "delete"]),
      resource: Schema.String,
      target: Schema.String,
    }),
  ),
  files: Schema.Array(FileDiff.Info),
})

export function fixturePath(directory: string, value: unknown, root = false) {
  if (typeof value !== "string" || !value || value.includes("\0")) return
  const name = path.relative(directory, path.resolve(directory, value))
  if (
    (!root && !name) ||
    name === ".." ||
    name.startsWith(`..${path.sep}`) ||
    path.isAbsolute(name) ||
    name.includes(":")
  )
    return
  return name.replaceAll("\\", "/")
}

/** These registered tools observe files/history, never run model-supplied commands.
 * Partial search results are not a Read receipt, but remain a known read-only action. */
export function knownReadOnly(tool: Tool, directory: string) {
  if (tool.state.status !== "completed") return false
  const input = tool.state.input
  const output = tool.state.structured
  if (tool.name === "read" && fixturePath(directory, input.path, true) === "") {
    const parsed = Schema.decodeUnknownOption(listing)(output)
    return (
      Option.isSome(parsed) && parsed.value.entries.every((entry) => fixturePath(directory, entry.path) !== undefined)
    )
  }
  if (tool.name === "memory_search")
    return (
      typeof input.query === "string" &&
      Array.isArray(output.pages) &&
      Array.isArray(output.notes) &&
      Array.isArray(output.conversations)
    )
  if (
    !["glob", "grep"].includes(tool.name) ||
    typeof input.pattern !== "string" ||
    fixturePath(directory, input.path === "" ? "." : (input.path ?? "."), true) === undefined
  )
    return false
  if (tool.name === "glob") {
    const parsed = Schema.decodeUnknownOption(glob)(output)
    return (
      Option.isSome(parsed) && parsed.value.entries.every((entry) => fixturePath(directory, entry.path) !== undefined)
    )
  }
  const parsed = Schema.decodeUnknownOption(grep)(output)
  return (
    Option.isSome(parsed) &&
    parsed.value.matches.every((match) => fixturePath(directory, match.entry.path) !== undefined)
  )
}

/** Correlate requested operations with both host applied targets and host diffs.
 * Missing/partial/conflicting receipts are not inferred from model patch text. */
export function patchChanges(tool: Tool, directory: string) {
  if (
    tool.name !== "apply_patch" ||
    tool.state.status !== "completed" ||
    typeof tool.state.input.patchText !== "string"
  )
    return
  const parsed = Schema.decodeUnknownOption(receipt)(tool.state.structured)
  if (Option.isNone(parsed)) return
  try {
    const requests = Patch.parse(tool.state.input.patchText)
    if (
      !requests.length ||
      requests.length !== parsed.value.applied.length ||
      requests.length !== parsed.value.files.length
    )
      return
    const changes = parsed.value.applied.map((applied, index) => {
      const requested = requests[index]!
      const file = parsed.value.files[index]!
      const name = fixturePath(directory, applied.target)
      if (
        !path.isAbsolute(applied.target) ||
        !name ||
        name !== fixturePath(directory, applied.resource) ||
        name !== fixturePath(directory, requested.path) ||
        name !== fixturePath(directory, file.file) ||
        applied.type !== requested.type ||
        (requested.type === "update" && requested.movePath !== undefined) ||
        file.status !== ({ add: "added", update: "modified", delete: "deleted" } as const)[applied.type] ||
        !file.patch
      )
        return
      const patches = parsePatch(file.patch)
      if (
        patches.length !== 1 ||
        fixturePath(directory, patches[0]!.oldFileName) !== name ||
        fixturePath(directory, patches[0]!.newFileName) !== name
      )
        return
      return { name, type: applied.type, patch: file.patch }
    })
    if (changes.some((change) => !change)) return
    const complete = changes.filter((change) => change !== undefined)
    if (new Set(complete.map((change) => change.name)).size !== complete.length) return
    return complete
  } catch {
    return // Existing patch parsers reject malformed input; do not guess its effects.
  }
}

export type CodeExecution = {
  messageID: string
  partID: string
  record: SessionOutcome.ExecutionRecord
  files: Record<string, string>
}

/** Replay complete host diffs from a host-owned initial snapshot, then bind every
 * executed code version. This supplies human review material, not an automatic JS proof. */
export function arithmeticReview(input: {
  directory: string
  initial: Record<string, string>
  final: Record<string, string>
  tools: readonly Tool[]
  commands: Array<{ tool: Tool; record: SessionOutcome.ExecutionRecord; command: string }>
  originalNpm?: readonly Tool[]
}) {
  const current = { ...input.initial }
  const versions: CodeExecution[] = []
  const relevant = input.tools.filter((tool) => ["apply_patch", "edit", "write", "bash"].includes(tool.name))
  const events = relevant
    .map((tool) => {
      const command = input.commands.find((entry) => entry.tool === tool)
      return {
        tool,
        command,
        start: command?.record.started ?? tool.time.ran,
        end: command?.record.completed ?? tool.time.completed,
      }
    })
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity))
  for (const [index, event] of events.entries()) {
    if (
      event.start === undefined ||
      event.end === undefined ||
      event.end < event.start ||
      (index > 0 && events[index - 1]!.end! > event.start)
    )
      return
    if (event.command) {
      const entry =
        event.command.command === "node --test test/sum.test.cjs" || input.originalNpm?.includes(event.tool)
          ? "test/sum.test.cjs"
          : ["node --test test/math.test.cjs", "npm run check"].includes(event.command.command)
            ? "test/math.test.cjs"
            : undefined
      if (!entry || ["src/sum.cjs", entry, "package.json"].some((name) => typeof current[name] !== "string")) return
      versions.push({
        messageID: event.tool.messageID,
        partID: event.tool.partID,
        record: event.command.record,
        files: Object.fromEntries(["src/sum.cjs", entry, "package.json"].map((name) => [name, current[name]!])),
      })
      continue
    }
    const changes = patchChanges(event.tool, input.directory)
    if (!changes) return // Unreceipted write/edit cannot create a certifiable code version.
    for (const change of changes) {
      if ((change.type === "add") !== (current[change.name] === undefined)) return
      const after = applyPatch(current[change.name] ?? "", change.patch, { fuzzFactor: 0 })
      if (after === false) return
      if (change.type === "delete") delete current[change.name]
      else current[change.name] = after
    }
  }
  if (
    !versions.length ||
    Object.keys(current).length !== Object.keys(input.final).length ||
    Object.entries(current).some(([name, text]) => input.final[name] !== text)
  )
    return
  return versions
}
