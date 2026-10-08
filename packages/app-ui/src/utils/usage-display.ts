import type { V2SessionUsageResponses } from "@zaovra-ai/sdk/v2/client"

type Totals = V2SessionUsageResponses[200]["data"]["total"]

export function usageDisplay(totals: Totals) {
  const input = totals.input + totals.cacheRead + totals.cacheWrite
  return {
    output: totals.output + totals.reasoning,
    hitRate: totals.unreported || !input ? undefined : totals.cacheRead / input,
    unknown: totals.unreported > 0 && totals.total === 0,
  }
}
