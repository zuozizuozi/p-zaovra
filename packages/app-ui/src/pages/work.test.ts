import { describe, expect, test } from "bun:test"
import { workGoalControlDisabled, workGoalControls, workGoalDuration } from "./work-controls"

describe("workGoalControls", () => {
  test("keeps omitted, unlimited and explicit goal durations separate", () => {
    expect(workGoalDuration({ mode: "default", minutes: "" })).toEqual({})
    expect(workGoalDuration({ mode: "unlimited", minutes: "720" })).toEqual({ maxDurationMs: null })
    expect(workGoalDuration({ mode: "custom", minutes: "15" })).toEqual({ maxDurationMs: 900_000 })
    for (const minutes of ["", "0", "-1", "NaN", "Infinity", "9007199254740991"]) {
      expect(workGoalDuration({ mode: "custom", minutes })).toBeUndefined()
    }
  })
  test("only exposes resume and pause in states accepted by the runner", () => {
    expect(workGoalControls("draft")).toMatchObject({ resume: true, pause: false })
    expect(workGoalControls("paused")).toMatchObject({ resume: true, pause: false })
    expect(workGoalControls("active")).toMatchObject({ resume: false, pause: true })
    expect(workGoalControls("pausing")).toMatchObject({ resume: false, pause: false })
    expect(workGoalControls("blocked")).toMatchObject({ resume: true, pause: false })
    expect(workGoalControls("budget_exhausted")).toMatchObject({ resume: false, pause: false })
  })

  test("keeps recovery and cancellation controls aligned with backend transitions", () => {
    expect(workGoalControls("blocked")).toMatchObject({ replan: true, cancel: true })
    expect(workGoalControls("budget_exhausted")).toMatchObject({ replan: true, cancel: true })
    expect(workGoalControls("completed")).toMatchObject({ replan: false, cancel: false })
    expect(workGoalControls("cancelled")).toMatchObject({ replan: false, cancel: false })
  })

  test("does not let a long resume request lock pause or cancel", () => {
    const input = { commands: ["resume"] }

    expect(workGoalControlDisabled({ ...input, command: "resume" })).toBe(true)
    expect(workGoalControlDisabled({ ...input, command: "pause" })).toBe(false)
    expect(workGoalControlDisabled({ ...input, command: "cancel" })).toBe(false)
  })
})
