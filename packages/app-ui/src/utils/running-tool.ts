import type { Part } from "@zaovra-ai/sdk/v2"

export function runningTool(parts: readonly Part[]) {
  const part = parts.findLast((part) => part.type === "tool" && part.state.status === "running")
  if (part?.type !== "tool" || part.state.status !== "running") return
  return {
    started: part.state.time.start,
    label:
      typeof part.state.input.command === "string"
        ? part.state.input.command.split(/\r?\n/)[0].slice(0, 160)
        : part.tool,
  }
}
