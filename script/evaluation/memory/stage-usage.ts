import { randomUUID } from "node:crypto"
import type { observeUsage } from "./usage"

export const StageUsageHeader = "x-zaovra-evaluation-stage"

type Observation = ReturnType<ReturnType<typeof observeUsage>["result"]>
type Binding = { runID: string; stage: number; sessionID: string }
type Request = Binding & { id: string; ordinal: number; usage: Observation }

export function createStageUsage(log: (record: object) => void) {
  const runID = randomUUID()
  const requests: Request[] = []
  const sessions = new Map<number, string>()
  let current: ReturnType<typeof open> | undefined
  let lastStage = 0

  function open(stage: number) {
    if (current || stage !== lastStage + 1) throw new Error("invalid-evaluation-usage-stage")
    const key = randomUUID()
    const pending = new Set<() => void>()
    let binding: Binding | undefined
    const owner = {
      key,
      get binding() {
        return binding
      },
      bindSession(sessionID: string) {
        if (current !== owner || binding || !/^ses_[a-zA-Z0-9]+$/.test(sessionID))
          throw new Error("invalid-evaluation-usage-session")
        const next = { runID, stage, sessionID }
        log({ phase: "stage-bound", ...next })
        binding = next
        sessions.set(stage, sessionID)
      },
      track(id: string, ordinal: number, cancel: () => void) {
        if (current !== owner || !binding) throw new Error("invalid-evaluation-usage-admission")
        const request: Request = { ...binding, id, ordinal, usage: { status: "unknown", reason: "no-terminal-usage" } }
        requests.push(request)
        pending.add(cancel)
        return (usage: Observation) => {
          request.usage = usage
          pending.delete(cancel)
        }
      },
      [Symbol.dispose]() {
        if (current !== owner) return
        current = undefined
        for (const cancel of pending) cancel()
      },
    }
    current = owner
    lastStage = stage
    return owner
  }

  return {
    runID,
    open,
    match(key: string | null) {
      return current?.binding && key === current.key ? current : undefined
    },
    close() {
      current?.[Symbol.dispose]()
    },
    summarize(stages: readonly { stage: number; status: "not-run" | "completed" | "failed" }[]) {
      if (current) throw new Error("evaluation-usage-stage-active")
      const perStage = stages.map(({ stage, status }) => {
        const selected = requests.filter((request) => request.stage === stage)
        return {
          stage,
          outcome: status,
          sessionID: sessions.get(stage) ?? null,
          ...summarize(selected, status),
          requests: selected,
        }
      })
      return {
        version: 1,
        runID,
        basis: "provider-terminal-usage",
        stages: perStage,
        fullChain: summarize(
          requests,
          perStage.every((stage) => stage.eligibleForCostComparison) ? "completed" : "failed",
        ),
        laterStages: summarize(
          requests.filter((request) => request.stage > 1),
          perStage.slice(1).every((stage) => stage.eligibleForCostComparison) ? "completed" : "failed",
        ),
      }
    },
  }
}

function summarize(requests: readonly Request[], outcome: "not-run" | "completed" | "failed") {
  const reported = requests.flatMap(({ usage }) => (usage.status === "reported" ? [usage] : []))
  const unknownRequests = requests.length - reported.length
  const totals = {
    input: reported.reduce((sum, usage) => sum + usage.input, 0),
    output: reported.reduce((sum, usage) => sum + usage.output, 0),
    total: reported.reduce((sum, usage) => sum + usage.total, 0),
  }
  const observed = reported.length && Object.values(totals).every(Number.isSafeInteger) ? totals : null
  return {
    status:
      outcome === "not-run"
        ? "not-run"
        : !requests.length
          ? "no-requests"
          : !observed
            ? "unknown"
            : unknownRequests
              ? "partial"
              : "reported",
    physicalRequests: requests.length,
    reportedRequests: reported.length,
    unknownRequests,
    observed,
    // An exact partial subtotal still does not cover an interrupted task.
    eligibleForCostComparison: outcome === "completed" && observed !== null && unknownRequests === 0,
  }
}
