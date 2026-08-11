export * as WorkRole from "./role"

import { AgentV2 } from "../agent"
import { Work } from "@zaovra-ai/schema/work"

const allItems: ReadonlyArray<Work.HandoffItemKind> = [
  "result",
  "fact",
  "decision",
  "constraint",
  "risk",
  "artifact",
  "lesson",
  "next_action",
]

export const contracts: ReadonlyArray<Work.RoleContract> = [
  contract({
    id: "build",
    agentID: "build",
    title: "Legacy Builder",
    purpose: "Backward-compatible implementation role for existing WorkGraphs.",
    capabilities: ["research", "design", "implement", "verify"],
    workspaceAccess: "write",
    allowedIsolation: ["shared", "worktree"],
    accepts: allItems,
    publishes: ["result", "fact", "decision", "constraint", "risk", "artifact", "lesson", "next_action"],
  }),
  contract({
    id: "general",
    agentID: "general",
    title: "Legacy Generalist",
    purpose: "Backward-compatible complex implementation role for existing WorkGraphs.",
    capabilities: ["research", "design", "implement", "verify"],
    workspaceAccess: "write",
    allowedIsolation: ["shared", "worktree"],
    accepts: allItems,
    publishes: ["result", "fact", "decision", "constraint", "risk", "artifact", "lesson", "next_action"],
  }),
  contract({
    id: "explore",
    agentID: "explore",
    title: "Researcher",
    purpose: "Inspect code and external context without modifying the workspace.",
    capabilities: ["research"],
    workspaceAccess: "read_only",
    allowedIsolation: ["shared"],
    accepts: ["result", "fact", "constraint", "risk", "artifact", "lesson", "next_action"],
    publishes: ["result", "fact", "risk", "artifact", "lesson", "next_action"],
  }),
  contract({
    id: "pm",
    agentID: "work-pm",
    title: "Product Manager",
    purpose: "Clarify outcomes, coordinate dependencies, and preserve product decisions.",
    capabilities: ["coordinate", "plan", "research"],
    workspaceAccess: "read_only",
    allowedIsolation: ["shared"],
    accepts: allItems,
    publishes: ["result", "fact", "decision", "constraint", "risk", "lesson", "next_action"],
  }),
  contract({
    id: "architect",
    agentID: "work-design-architect",
    title: "Architect",
    purpose: "Define technical boundaries and architecture decisions without implementing them.",
    capabilities: ["research", "design", "audit"],
    workspaceAccess: "read_only",
    allowedIsolation: ["shared"],
    accepts: allItems,
    publishes: ["result", "fact", "decision", "constraint", "risk", "artifact", "lesson", "next_action"],
  }),
  contract({
    id: "developer",
    agentID: "work-developer",
    title: "Developer",
    purpose: "Implement an assigned change and produce evidence-backed results.",
    capabilities: ["research", "design", "implement", "verify"],
    workspaceAccess: "write",
    allowedIsolation: ["shared", "worktree"],
    accepts: ["result", "fact", "decision", "constraint", "risk", "artifact", "next_action"],
    publishes: ["result", "fact", "decision", "constraint", "risk", "artifact", "lesson", "next_action"],
  }),
  contract({
    id: "qa",
    agentID: "work-qa",
    title: "Quality Engineer",
    purpose: "Challenge behavior, test coverage, and acceptance evidence independently.",
    capabilities: ["research", "verify", "audit"],
    workspaceAccess: "read_only",
    allowedIsolation: ["shared"],
    accepts: ["result", "fact", "decision", "constraint", "risk", "artifact", "lesson"],
    publishes: ["result", "fact", "risk", "artifact", "lesson", "next_action"],
  }),
  contract({
    id: "security",
    agentID: "work-security",
    title: "Security Engineer",
    purpose: "Audit trust boundaries and identify evidence-backed security risks and constraints.",
    capabilities: ["research", "verify", "audit"],
    workspaceAccess: "read_only",
    allowedIsolation: ["shared"],
    accepts: ["result", "fact", "decision", "constraint", "risk", "artifact", "lesson"],
    publishes: ["result", "fact", "constraint", "risk", "artifact", "lesson", "next_action"],
  }),
]

export function get(role: string, roleContracts: ReadonlyArray<Work.RoleContract> = contracts) {
  return roleContracts.find((contract) => contract.id === role)
}

export function agentID(role: string, roleContracts: ReadonlyArray<Work.RoleContract> = contracts) {
  const found = get(role, roleContracts)
  return found ? AgentV2.ID.make(found.agentID) : undefined
}

export function allowsIsolation(
  role: string,
  isolation: Work.PlanIsolation,
  roleContracts: ReadonlyArray<Work.RoleContract> = contracts,
) {
  return get(role, roleContracts)?.allowedIsolation.includes(isolation) === true
}

export function normalizeHandoff(
  role: string,
  output: Work.HandoffOutput,
  roleContracts: ReadonlyArray<Work.RoleContract> = contracts,
) {
  const publishes = new Set(get(role, roleContracts)?.publishes ?? ["result"])
  const items = output.items
    .filter((item) => publishes.has(item.kind))
    .map((item) => {
      const key = item.key?.trim().slice(0, 200)
      const memory = item.memory === "project" && key ? ("project" as const) : ("task" as const)
      return {
        kind: item.kind,
        text: item.text,
        ...(item.reference ? { reference: item.reference } : {}),
        memory,
        ...(key ? { key } : {}),
        ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
      }
    })
  return Work.HandoffOutput.make({
    summary: output.summary,
    items: items.length > 0 ? items : [{ kind: "result", text: output.summary.slice(0, 4_000), memory: "task" }],
  })
}

export function acceptsHandoff(
  role: string,
  handoff: Work.HandoffInfo,
  roleContracts: ReadonlyArray<Work.RoleContract> = contracts,
) {
  const accepted = new Set(get(role, roleContracts)?.accepts ?? ["result"])
  return handoff.items.filter((item) => accepted.has(item.kind))
}

export function guidance(roleContracts: ReadonlyArray<Work.RoleContract> = contracts) {
  return roleContracts
    .filter((contract) => contract.id !== "build" && contract.id !== "general")
    .map(
      (contract) =>
        `- ${contract.id}: ${contract.purpose} Access=${contract.workspaceAccess}; isolation=${contract.allowedIsolation.join("|")}; capabilities=${contract.capabilities.join(",")}.`,
    )
    .join("\n")
}

function contract(input: Work.RoleContract) {
  return Work.RoleContract.make(input)
}
