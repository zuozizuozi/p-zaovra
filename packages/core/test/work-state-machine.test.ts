import { describe, expect, test } from "bun:test"
import { WorkStateMachine } from "@zaovra-ai/core/work/state-machine"

describe("WorkStateMachine", () => {
  test("accepts the bounded execute and review path", () => {
    expect(() => WorkStateMachine.goal("draft", "active")).not.toThrow()
    expect(() => WorkStateMachine.goal("active", "pausing")).not.toThrow()
    expect(() => WorkStateMachine.goal("pausing", "paused")).not.toThrow()
    expect(() => WorkStateMachine.goal("active", "cancelling")).not.toThrow()
    expect(() => WorkStateMachine.goal("cancelling", "cancelled")).not.toThrow()
    expect(() => WorkStateMachine.task("pending", "ready")).not.toThrow()
    expect(() => WorkStateMachine.task("ready", "running")).not.toThrow()
    expect(() => WorkStateMachine.task("running", "verifying")).not.toThrow()
    expect(() => WorkStateMachine.task("verifying", "reviewing")).not.toThrow()
    expect(() => WorkStateMachine.task("reviewing", "completed")).not.toThrow()
    expect(() => WorkStateMachine.task("blocked", "rework")).not.toThrow()
    expect(() => WorkStateMachine.task("blocked", "superseded")).not.toThrow()
  })

  test("rejects reviving terminal state", () => {
    expect(() => WorkStateMachine.goal("completed", "active")).toThrow("Invalid goal transition")
    expect(() => WorkStateMachine.task("completed", "rework")).toThrow("Invalid task transition")
    expect(() => WorkStateMachine.task("superseded", "rework")).toThrow("Invalid task transition")
    expect(() => WorkStateMachine.attempt("succeeded", "running")).toThrow("Invalid attempt transition")
  })
})
