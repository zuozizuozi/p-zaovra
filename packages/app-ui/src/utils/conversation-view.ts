export const conversationViews = ["normal", "thinking", "detailed"] as const
export type ConversationView = (typeof conversationViews)[number]

export function conversationViewFromLegacy(reasoning: boolean, shell: boolean, edit: boolean): ConversationView {
  if (shell || edit) return "detailed"
  return reasoning ? "thinking" : "normal"
}

export function conversationViewFlags(view: ConversationView) {
  return { reasoning: view !== "normal", shell: view === "detailed", edit: view === "detailed" }
}
