import { ConfigPermissionV1 } from "@zaovra-ai/core/v1/config/permission"
import { Wildcard } from "@zaovra-ai/core/util/wildcard"
import { Permission } from "@zaovra-ai/schema/permission"
import os from "os"

export const Ruleset = Permission.Ruleset
export type Ruleset = Permission.Ruleset
export type Rule = Permission.Rule

export function evaluate(action: string, resource: string, ...rulesets: Ruleset[]): Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

function expand(resource: string) {
  if (resource.startsWith("~/")) return os.homedir() + resource.slice(1)
  if (resource === "~") return os.homedir()
  if (resource.startsWith("$HOME/")) return os.homedir() + resource.slice(5)
  if (resource.startsWith("$HOME")) return os.homedir() + resource.slice(5)
  return resource
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  return Object.entries(permission).flatMap(([action, value]) => {
    if (typeof value === "string") return [{ action, resource: "*", effect: value }]
    return Object.entries(value).map(([resource, effect]) => ({ action, resource: expand(resource), effect }))
  }) satisfies Rule[]
}

export function merge(...rulesets: Ruleset[]): Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const action = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(action, rule.action))
      return rule?.resource === "*" && rule.effect === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export * as PermissionRules from "."
