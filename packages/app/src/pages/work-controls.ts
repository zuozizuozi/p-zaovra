import type { WorkGoalStatus } from "@zaovra-ai/sdk/v2/client"

export function workGoalControls(status: WorkGoalStatus) {
  return {
    resume: status === "draft" || status === "paused" || status === "blocked",
    pause: status === "active",
    replan: status === "active" || status === "paused" || status === "blocked" || status === "budget_exhausted",
    cancel: status !== "completed" && status !== "cancelled",
  }
}

export function workGoalControlDisabled(input: { busy?: string; commands: string[]; command: string }) {
  return Boolean(input.busy) || input.commands.includes(input.command)
}
