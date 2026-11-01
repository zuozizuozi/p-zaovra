export * as SessionMessage from "./message"
export * from "@zaovra-ai/schema/session-message"

import type { Message } from "@zaovra-ai/schema/session-message"

/** Only model/summary projections omit this duplicate; durable history and UI keep it. */
export const isToolOwnedShell = (message: Message) =>
  message.type === "shell" &&
  (message.origin === "tool" ||
    (message.origin === undefined && message.id === message.callID && message.id.startsWith("msg_bash_")))
