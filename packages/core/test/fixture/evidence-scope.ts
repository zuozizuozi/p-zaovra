import type { SessionOutcome } from "@zaovra-ai/schema/session-outcome"

export function evidenceScope(callID: string): SessionOutcome.EvidenceScope {
  return {
    callID,
    dimensions: ["behavior"],
    inputScale: "fixture inputs",
    generalization: "contract fixture, no broader claim",
    performance: "not requested",
    dependencies: "real",
    artifacts: "not-applicable",
    result: "passed",
  }
}
