import { createStore } from "solid-js/store"
import { Feedback } from "@zaovra-ai/schema/feedback"
import { feedbackIpcSnapshot } from "../src/renderer/feedback-snapshot"

export async function exerciseBridge(submit: (value: unknown) => Promise<unknown>) {
  const snapshot = Feedback.snapshot({
    now: 0,
    description: "585 controlled bridge fixture",
    context: {},
    include: {},
    modelNames: { provider: "fixture", model: "fixture" },
  })
  const [state] = createStore({ preview: snapshot })
  let proxyRejected = false
  try {
    await submit(state.preview)
  } catch {
    proxyRejected = true
  }
  const projected = feedbackIpcSnapshot(state.preview)
  const receipt = await submit(projected)
  let invalidRejected = false
  try {
    await submit({ text: "invalid", files: [] })
  } catch {
    invalidRejected = true
  }
  return { proxyRejected, receipt, invalidRejected, preview: projected }
}

Object.assign(window, { exerciseBridge })
