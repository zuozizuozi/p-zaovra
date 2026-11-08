export type VerificationLabel = "modelReview" | "commandPassed" | "commandFailed" | "missingEvidence"

export function commandVerification(check: {
  exit?: unknown
  execution?: unknown
  eligiblePass?: boolean
  supersededBy?: unknown
}): VerificationLabel {
  if (check.execution || check.supersededBy || typeof check.exit !== "number" || !Number.isFinite(check.exit))
    return "missingEvidence"
  if (check.exit !== 0) return "commandFailed"
  return check.eligiblePass === false ? "missingEvidence" : "commandPassed"
}

export function workVerification(
  item: { kind: string; producer: string; payload: unknown },
  verdict?: string,
): VerificationLabel {
  if (item.kind === "review") return "modelReview"
  if (!item.payload || typeof item.payload !== "object") return "missingEvidence"
  const raw = item.payload as Record<string, unknown>
  const payload =
    item.producer === "work-verifier/command" && "artifactDigest" in raw && raw.result && typeof raw.result === "object"
      ? (raw.result as Record<string, unknown>)
      : raw
  if (item.producer === "session-host/1" && Array.isArray(payload.checks)) {
    const labels = payload.checks
      .filter(
        (check: unknown) => !(check && typeof check === "object" && "supersededBy" in check && check.supersededBy),
      )
      .map((check: unknown) =>
        check && typeof check === "object" && "eligiblePass" in check && "exit" in check
          ? commandVerification({ ...check, eligiblePass: check.eligiblePass === true })
          : "missingEvidence",
      )
    if (labels.includes("commandFailed")) return "commandFailed"
    if (
      !labels.length ||
      labels.includes("missingEvidence") ||
      (Array.isArray(payload.missing) && payload.missing.length)
    )
      return "missingEvidence"
    return "commandPassed"
  }
  // A model-authored payload with an exitCode is not host command evidence.
  if (
    item.producer !== "work-verifier/command" ||
    payload.type !== "command" ||
    typeof payload.exitCode !== "number" ||
    payload.error
  )
    return "missingEvidence"
  // The verifier owns successExitCodes; non-zero can be an explicitly accepted result.
  if (verdict === "pass") return "commandPassed"
  if (verdict === "fail") return "commandFailed"
  return "missingEvidence"
}
