import { ToolFailure } from "@zaovra-ai/llm"
import { PermissionV2 } from "../permission"
import { FileMutation } from "../file-mutation"

/** Only these typed failures expose actionable details across the tool boundary. */
export function safetyFailure(error: unknown) {
  if (error instanceof PermissionV2.BlockedError)
    return new ToolFailure({
      message:
        "Tool not executed: permission policy blocked this action. Use an already permitted action or ask the user to change permission.",
      metadata: { phase: "permission", reason: error._tag },
    })
  if (error instanceof PermissionV2.CorrectedError)
    return new ToolFailure({
      message: `Tool not executed: the permission request was corrected.\n${error.feedback}`,
      metadata: { phase: "permission", reason: error._tag },
    })
  if (error instanceof FileMutation.TargetChangedError)
    return new ToolFailure({
      message:
        "File target identity changed. Write stopped; resolve the target and request permission again. Inspect any partial effects before retrying.",
      metadata: { phase: "mutation", reason: "target-changed" },
    })
  if (error instanceof FileMutation.StaleContentError)
    return new ToolFailure({
      message:
        "File content changed or does not match expectedContent. Nothing was overwritten. Read the file again before editing.",
      metadata: { phase: "mutation", reason: "stale-content" },
    })
  if (error instanceof FileMutation.TargetExistsError)
    return new ToolFailure({
      message: "File already exists. Nothing was overwritten. Read and edit it or provide exact expectedContent.",
      metadata: { phase: "mutation", reason: "target-exists" },
    })
}

export function safetyMetadata(metadata: Readonly<Record<string, unknown>> | undefined) {
  if (!metadata) return undefined
  if (
    metadata.phase === "execution" &&
    [
      "shell-unavailable",
      "environment-changed",
      "command-not-found",
      "syntax-incompatible",
      "timeout",
      "cancelled",
      "non-zero-exit",
    ].includes(String(metadata.reason))
  )
    return { phase: "execution", reason: String(metadata.reason) }
  if (
    metadata.phase === "permission" &&
    (metadata.reason === "PermissionV2.BlockedError" || metadata.reason === "PermissionV2.CorrectedError")
  )
    return { phase: "permission", reason: metadata.reason }
  if (
    metadata.phase === "mutation" &&
    [
      "target-changed",
      "stale-content",
      "target-exists",
      "match-failed",
      "patch-failed",
      "partial-application",
    ].includes(String(metadata.reason))
  )
    return {
      phase: "mutation",
      reason: String(metadata.reason),
      ...(metadata.reason === "partial-application" && typeof metadata.appliedFiles === "string"
        ? { appliedFiles: metadata.appliedFiles }
        : {}),
    }
}
