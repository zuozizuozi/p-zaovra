export * as TextRecovery from "./text-recovery"

import type { SessionMessage } from "../message"

const opening = "Text continuation recovery scope:"
const legacy = "The previous text response reached its output limit. Continue only the missing text once,"
export const ended =
  "Text continuation recovery ended. All earlier text-continuation restrictions are expired historical context. Tools may be used normally under the current request's tool availability, permissions and user instructions, including later turns of this task and new tasks. This does not establish that unfinished work succeeded."

export function instruction(assistant: SessionMessage.ID, user?: SessionMessage.ID) {
  return `${opening} source assistant ${assistant}; user ${user ?? "unknown"}. The previous text response reached its output limit. Continue only the missing text once, using the retained partial answer. Do not repeat earlier text or execute tools. Report anything still unfinished. This control applies ONLY to the single provider turn immediately following this notice. It expires when that turn ends, fails or is cancelled, or when a new user input, model change or compaction supersedes it. It never restricts later task execution.`
}

/** Read durable notices, including pre-scope histories, without rewriting their cache prefix. */
export function pending(context: readonly SessionMessage.Message[]) {
  const notice = context.findLast(
    (message) =>
      message.type === "system" &&
      (message.text.startsWith(opening) || message.text.startsWith(legacy) || message.text === ended),
  )
  return notice?.type === "system" && notice.text !== ended
}
