import { expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { Feedback } from "@zaovra-ai/schema/feedback"
import { feedbackIpcSnapshot } from "../src/renderer/feedback-snapshot"

test("the exact preview held in a Solid store crosses the real structured-clone boundary", () => {
  const snapshot = Feedback.snapshot({
    now: 0,
    description: "synthetic 584",
    context: {},
    include: {},
    modelNames: { provider: "fixture", model: "fixture" },
  })
  const [state] = createStore({ preview: snapshot })
  expect(() => structuredClone(state.preview)).toThrow()
  const cloned = structuredClone(feedbackIpcSnapshot(state.preview))
  expect(Feedback.validSnapshot(cloned)).toBe(true)
  expect(cloned).toEqual(snapshot)
})
