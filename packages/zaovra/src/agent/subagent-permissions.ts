import { Permission } from "@zaovra-ai/schema/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: Permission.Ruleset
  subagent: Agent.Info
}): Permission.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.action === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.action === "todowrite")
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.action === "external_directory" || rule.effect === "deny",
    ),
    ...(canTodo ? [] : [{ action: "todowrite", resource: "*", effect: "deny" as const }]),
    ...(canTask ? [] : [{ action: "task", resource: "*", effect: "deny" as const }]),
  ]
}
