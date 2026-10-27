import { Binary } from "@zaovra-ai/core/util/binary"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@zaovra-ai/sdk/v2"
import { createMemo, mapArray, type Accessor } from "solid-js"
import { reuseTimelineRows } from "./row-reconciliation"
import { Timeline, TimelineRow } from "./rows"
import { displayTurnOwners } from "@zaovra-ai/session-ui/turn-ownership"
import { quietToolFailures } from "@zaovra-ai/session-ui/tool-recovery"
import { placeToolFailuresAfterAnswer } from "./tool-failure-rows"

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
  const chronologicalMessages = createMemo(() =>
    input.messages().toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id)),
  )
  const displayTurns = createMemo(() => displayTurnOwners(input.messages(), input.parts))
  const assistantMessagesByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    chronologicalMessages().forEach((message) => {
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
    chronologicalMessages().forEach((message) => {
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
  const quietParts = createMemo(() => {
    const result = new Set<string>()
    const parts = Object.fromEntries(input.messages().map((message) => [message.id, input.parts(message.id)]))
    assistantMessagesByTurn().forEach((messages) => {
      const latest = messages.at(-1)
      if (
        !latest ||
        !messages.some((message) =>
          parts[message.id].some((part) => part.type === "tool" && part.state.status === "error"),
        )
      )
        return
      quietToolFailures({
        message: latest,
        messages: input.messages(),
        parts,
        working: input.status().type !== "idle",
      }).forEach((part) => result.add(part.id))
    })
    return result
  })
  const activeMessageID = createMemo(() => {
    const parentID = chronologicalMessages().findLast(
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
    return input.userMessages().at(-1)?.id
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
    const groups = new Map<string, TimelineRow.TimelineRow[]>()
    messageRowMemos().forEach((memo) =>
      memo().forEach((row) => {
        const owner = displayTurns().get(row.userMessageID) ?? row.userMessageID
        const group = groups.get(owner)
        if (group) group.push(row)
        if (!group) groups.set(owner, [row])
      }),
    )
    const projected = [...groups]
      .sort(
        ([a], [b]) =>
          (messageByID().get(a)?.time.created ?? 0) - (messageByID().get(b)?.time.created ?? 0) || a.localeCompare(b),
      )
      .flatMap(([owner, rows]) => {
        const last = assistantMessagesByTurn().get(owner)?.at(-1)
        const working =
          input.status().type !== "idle" && (displayTurns().get(activeMessageID() ?? "") ?? activeMessageID()) === owner
        return placeToolFailuresAfterAnswer(
          rows,
          input.parts,
          quietParts(),
          !working && typeof last?.time.completed === "number" && last.finish !== "tool-calls",
        )
      })
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
    quietParts,
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
