import type { WorkGoalStatus } from "@zaovra-ai/sdk/v2/client"

export function workGoalDuration(input: { mode: "default" | "unlimited" | "custom"; minutes: string }) {
  if (input.mode === "default") return {}
  if (input.mode === "unlimited") return { maxDurationMs: null }
  const duration = Number(input.minutes) * 60_000
  if (!input.minutes.trim() || !Number.isSafeInteger(duration) || duration <= 0) return
  return { maxDurationMs: duration }
}

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
