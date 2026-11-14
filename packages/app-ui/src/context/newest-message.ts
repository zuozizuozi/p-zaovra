import type { Message, Part } from "@zaovra-ai/sdk/v2/client"

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

/**
 * The last thing the user actually sent. Command records and host notices are stored as user
 * messages too, with every part marked synthetic; they are not something the user asked.
 */
export function newestPrompt(
  messages: readonly Message[] | undefined,
  parts: (messageID: string) => readonly Part[] | undefined,
) {
  return newestMessage(
    messages?.filter((message) => {
      if (message.role !== "user") return false
      const own = parts(message.id)
      return !own?.length || own.some((part) => !(part.type === "text" && part.synthetic))
    }),
  )
}
