import { Binary } from "@zaovra-ai/core/util/binary"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@zaovra-ai/sdk/v2"
import { createMemo, mapArray, type Accessor } from "solid-js"
import { reuseTimelineRows } from "./row-reconciliation"
import { Timeline, TimelineRow } from "./rows"

export { reuseTimelineRows } from "./row-reconciliation"

const emptyAssistantMessages: AssistantMessage[] = []

export function createTimelineProjection(input: {
  messages: Accessor<Message[]>
  userMessages: Accessor<UserMessage[]>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  showReasoningSummaries: Accessor<boolean>
  inlineComments: Accessor<boolean>
}) {
  const messageByID = createMemo(() => new Map(input.messages().map((message) => [message.id, message] as const)))
  // Host completion and synthetic continuation keep the preceding human turn's heading.
  const displayTurns = createMemo(() => {
    const owners = new Map<string, string>()
    input.userMessages().reduce<string | undefined>((previous, message) => {
      const parts = input.parts(message.id)
      const continuation =
        parts.length > 0 &&
        parts.every(
          (part) =>
            part.type === "step-start" || part.type === "compaction" || (part.type === "text" && part.synthetic),
        )
      const owner = continuation && previous ? previous : message.id
      owners.set(message.id, owner)
      return owner
    }, undefined)
    return owners
  })
  const assistantMessagesByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    input.messages().forEach((message) => {
      if (message.role !== "assistant") return
      const messages = result.get(message.parentID)
      if (messages) {
        messages.push(message)
        return
      }
      result.set(message.parentID, [message])
    })
    return result
  })
  const assistantMessagesByTurn = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    input.messages().forEach((message) => {
      if (message.role !== "assistant") return
      const owner = displayTurns().get(message.parentID) ?? message.parentID
      const messages = result.get(owner)
      if (messages) {
        messages.push(message)
        return
      }
      result.set(owner, [message])
    })
    return result
  })
  const activeMessageID = createMemo(() => {
    const parentID = input
      .messages()
      .findLast(
        (message): message is AssistantMessage =>
          message.role === "assistant" && typeof message.time.completed !== "number",
      )?.parentID
    if (parentID) {
      const messages = input.messages()
      const result = Binary.search(messages, parentID, (message) => message.id)
      const message = result.found ? messages[result.index] : messages.find((item) => item.id === parentID)
      if (message?.role === "user") return message.id
    }

    if (input.status().type === "idle") return
    return input.messages().findLast((message) => message.role === "user")?.id
  })
  const messageRowMemos = createMemo(
    mapArray(input.userMessages, (userMessage, indexAccessor) =>
      createMemo((previous: TimelineRow.TimelineRow[] | undefined) =>
        reuseTimelineRows(
          previous,
          Timeline.constructMessageRows(
            userMessage,
            input.parts,
            assistantMessagesByParent().get(userMessage.id) ?? emptyAssistantMessages,
            indexAccessor(),
            input.showReasoningSummaries(),
            input.status().type,
            activeMessageID() === userMessage.id,
            input.inlineComments(),
          ),
        ),
      ),
    ),
  )
  const rows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) => {
    const projected = messageRowMemos().flatMap((memo) => memo())
    const headings = new Set(
      projected.flatMap((row) =>
        row._tag === "AssistantHeading" ? [displayTurns().get(row.userMessageID) ?? row.userMessageID] : [],
      ),
    )
    return reuseTimelineRows(
      previous,
      projected.flatMap<TimelineRow.TimelineRow>((row) => {
        if (row._tag === "AssistantHeading") return []
        if (row._tag === "UserMessage" && headings.has(row.userMessageID))
          return [row, new TimelineRow.AssistantHeading({ userMessageID: row.userMessageID })]
        return [row]
      }),
    )
  })
  const rowByKey = createMemo(() => new Map(rows().map((row) => [TimelineRow.key(row), row] as const)))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if (!("userMessageID" in row) || result.has(row.userMessageID)) return
      result.set(row.userMessageID, index)
    })
    return result
  })
  const messageLastRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if ("userMessageID" in row) result.set(row.userMessageID, index)
    })
    return result
  })
  const lastAssistantGroupKey = createMemo(() => {
    const result = new Map<string, string>()
    rows().forEach((row) => {
      if (row._tag === "AssistantPart") result.set(row.userMessageID, row.group.key)
    })
    return result
  })

  return {
    activeMessageID,
    assistantMessagesByParent,
    assistantMessagesByTurn,
    displayTurns,
    lastAssistantGroupKey,
    messageByID,
    messageRowIndex,
    messageLastRowIndex,
    rowByKey,
    rows,
  }
}
