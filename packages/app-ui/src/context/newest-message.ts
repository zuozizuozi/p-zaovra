import type { Message } from "@zaovra-ai/sdk/v2/client"

/**
 * The message that was created last. The session store keeps messages sorted by ID for lookup, and
 * IDs are not chronological across kinds: a command record's ID sorts after every reply's.
 */
export function newestMessage(messages: readonly Message[] | undefined) {
  return messages?.reduce<Message | undefined>(
    (newest, message) =>
      !newest ||
      message.time.created > newest.time.created ||
      (message.time.created === newest.time.created && message.id > newest.id)
        ? message
        : newest,
    undefined,
  )
}
