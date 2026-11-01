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
