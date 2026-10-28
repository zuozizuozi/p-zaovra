import type { Feedback } from "@zaovra-ai/schema/feedback"

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
