export * as ToolProfile from "./tool-profile"
import type { ToolDefinition } from "@zaovra-ai/llm"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import type { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"
import type { PermissionV2 } from "../permission"
import type { SessionMessage } from "./message"
const deferred = new Set([
  "edit",
  "write",
  "browser",
  "task",
  "webfetch",
  "websearch",
  "question",
  "todowrite",
  "publish_artifact",
])
/** Select advertisements only. Canonical registration, validation and execution stay unchanged. */
export function select(
  definitions: readonly ToolDefinition[],
  input: {
    model: string
    history: readonly SessionMessage.Message[]
    permissions?: PermissionV2.Ruleset
    custom?: readonly string[]
    recalled?: readonly string[]
    explicit?: boolean
    repair?: boolean
  },
) {
  if (
    input.repair ||
    input.explicit ||
    !/^gpt-/i.test(input.model) ||
    !definitions.some((tool) => tool.name === "tool_search")
  )
    return definitions
  const active = new Set([...(input.custom ?? []), ...(input.recalled ?? [])])
  const requests = input.history
    .filter((message) => message.type === "user")
    .map((message) => message.text)
    .join("\n")
  for (const message of input.history) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool") continue
      // Includes old explicit calls and failed tools: a failure cannot hide the recovery tool.
      active.add(part.name)
      if (part.name !== "tool_search" || part.state.status !== "completed") continue
      const names = part.state.structured.activated
      if (Array.isArray(names)) for (const name of names) if (typeof name === "string") active.add(name)
    }
  }
  const words = new Set(requests.split(/[^a-zA-Z0-9_]+/))
  for (const tool of definitions) {
    const action = ["edit", "write", "apply_patch"].includes(tool.name) ? "edit" : tool.name
    if (
      input.permissions?.some(
        (rule) => (rule.action === action || rule.action === tool.name) && rule.effect === "allow",
      )
    )
      active.add(tool.name)
    if (words.has(tool.name)) active.add(tool.name)
  }
  // A replacement patch tool is not assumed when patch is unavailable (including deny rules).
  if (!definitions.some((tool) => tool.name === "apply_patch")) {
    active.add("edit")
    active.add("write")
  }
  return definitions.filter((tool) => !deferred.has(tool.name) || active.has(tool.name))
}
/** Read only tool names/discoveries, across user turns and compaction; never replay old tools. */
export const recalled = Effect.fn("ToolProfile.recalled")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select({
      name: sql<string>`json_extract(profile_tool.value, '$.name')`,
      activated: sql<
        string | null
      >`CASE WHEN json_extract(profile_tool.value, '$.name') = 'tool_search' AND json_extract(profile_tool.value, '$.state.status') = 'completed' THEN json_extract(profile_tool.value, '$.state.structured.activated') END`,
    })
    .from(SessionMessageTable)
    .innerJoin(sql`json_each(${SessionMessageTable.data}, '$.content') AS profile_tool`, sql`1`)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        sql`json_extract(profile_tool.value, '$.type') = 'tool'`,
      ),
    )
    .all()
    .pipe(Effect.orDie)
  return [
    ...new Set(
      rows.flatMap((row) => {
        const names = Schema.decodeUnknownOption(
          Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Schema.Array(Schema.String))),
        )(row.activated)
        return [row.name, ...(Option.isSome(names) ? names.value : [])]
      }),
    ),
  ]
})
