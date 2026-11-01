import type { ZaovraClient } from "@zaovra-ai/sdk/v2"

export function runDuration(value: string | undefined) {
  if (value === undefined) return
  if (value === "unlimited") return { durationMs: null }
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("--duration-ms must be a positive integer or 'unlimited'")
  }
  return { durationMs: Number(value) }
}

export async function applyRunDuration(
  sdk: Pick<ZaovraClient, "v2">,
  sessionID: string,
  budget: ReturnType<typeof runDuration>,
) {
  if (!budget) return
  // Updating a limit alone never resumes a stopped session.
  await sdk.v2.session.update({ sessionID, budget }, { throwOnError: true })
}

/** Host selection only. No reserve is inferred from task text or model output. */
export function runHostPolicy(interactive: boolean, deadline?: number, closingReserveMs?: number) {
  if (deadline !== undefined && !Number.isSafeInteger(deadline))
    throw new Error("--deadline-ms must be a finite safe integer Unix timestamp")
  if (
    closingReserveMs !== undefined &&
    (!Number.isSafeInteger(closingReserveMs) || closingReserveMs < 0 || deadline === undefined)
  )
    throw new Error("--closing-reserve-ms requires --deadline-ms and a non-negative integer")
  const mode = interactive ? ("interactive" as const) : ("unattended" as const)
  if (deadline === undefined) return { mode }
  return {
    mode,
    deadline,
    ...(closingReserveMs === undefined ? {} : { closingReserveMs }),
  }
}
