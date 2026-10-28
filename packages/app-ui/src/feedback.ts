import type { Feedback } from "@zaovra-ai/schema/feedback"
import { onCleanup } from "solid-js"

export type FeedbackRequest = {
  error?: string
  description?: string
  context?: Feedback.Context
  readConversation?: () => string
  configure?: () => void
}

export function openFeedback(input: FeedbackRequest = {}) {
  const request = { ...input }
  // Mounted session owners can add only their current structured scene. The
  // host works without them, including outside a failed router/provider tree.
  window.dispatchEvent(new CustomEvent("zaovra:feedback-scene", { detail: request }))
  window.dispatchEvent(new CustomEvent("zaovra:feedback", { detail: request }))
}

export function feedbackSlash(text: string) {
  return /^\/bug(?:[ \t]+([^\r\n]*))?$/.exec(text.trim())?.[1] ?? (text.trim() === "/bug" ? "" : undefined)
}

export function useFeedbackModel(model: () => { provider: { id: string }; id: string } | undefined) {
  const collect = (event: Event) => {
    const current = model()
    if (!current) return
    const request = (event as CustomEvent<FeedbackRequest>).detail
    request.context = { ...request.context, provider: current.provider.id, model: current.id }
  }
  window.addEventListener("zaovra:feedback-scene", collect)
  onCleanup(() => window.removeEventListener("zaovra:feedback-scene", collect))
}
