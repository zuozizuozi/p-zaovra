import { expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, UserMessage } from "@zaovra-ai/sdk/v2"
import { displayTurnOwners } from "./turn-ownership"

const user = (id: string, created: number): UserMessage => ({
  id,
  sessionID: "session",
  role: "user",
  time: { created },
  agent: "build",
  model: { providerID: "fixture", modelID: "fixture" },
})
const text = (id: string, source?: string): Extract<Part, { type: "text" }> => ({
  id: `${id}:text`,
  messageID: id,
  sessionID: "session",
  type: "text",
  text: "structural fixture",
  synthetic: true,
  metadata: source ? { zaovraSourceMessageID: source } : undefined,
})
const human = (id: string): Part => ({ ...text(id), synthetic: false })
const answer = (id: string, parentID: string, created: number) =>
  ({
    id,
    parentID,
    sessionID: "session",
    role: "assistant",
    time: { created, completed: created + 1 },
  }) as AssistantMessage

test("the sanitized two-round shell fixture uses creation order, never shell ID order", () => {
  const messages = [
    user("msg_1_human", 1),
    user("msg_bash_1", 2),
    answer("msg_2_answer", "msg_bash_1", 4),
    user("msg_3_human", 6),
    user("msg_bash_2", 7),
    answer("msg_4_answer", "msg_bash_2", 9),
  ]
  const before = messages.toSorted((a, b) => a.id.localeCompare(b.id))
  const owners = displayTurnOwners(before, (id) => (id.startsWith("msg_bash") ? [text(id)] : [human(id)]))
  expect(owners.get("msg_bash_1")).toBe("msg_1_human")
  expect(owners.get("msg_bash_2")).toBe("msg_3_human")
  expect(before.map((m) => m.id)).toEqual([...before].map((m) => m.id).sort())
})

test("explicit completion source wins over a newer human and survives reconnect ordering", () => {
  const messages: Message[] = [user("old", 1), answer("old-answer", "old", 2), user("new", 3), user("completion", 4)]
  const owners = displayTurnOwners(messages.toReversed(), (id) => (id === "completion" ? [text(id, "old-answer")] : []))
  expect(owners.get("completion")).toBe("old")
  expect(owners.get("new")).toBe("new")
})

test("same-millisecond, missing explicit parent and source cycles remain unassigned", () => {
  const messages = [user("old", 1), user("new", 3), user("same", 3), user("missing", 4), user("cycle", 5)]
  const parts = (id: string) =>
    id === "same" ? [text(id)] : id === "missing" ? [text(id, "absent")] : id === "cycle" ? [text(id, id)] : [human(id)]
  const owners = displayTurnOwners(messages, parts)
  expect(owners.get("same")).toBe("same")
  expect(owners.get("missing")).toBe("missing")
  expect(owners.get("cycle")).toBe("cycle")
})

test("pagination resolves an older source only when that source is hydrated", () => {
  const part = (id: string) => (id === "completion" ? [text(id, "parent")] : [])
  const page = [user("new", 3), user("completion", 4)]
  expect(displayTurnOwners(page, part).get("completion")).toBe("completion")
  expect(displayTurnOwners([user("parent", 1), ...page], part).get("completion")).toBe("parent")
})

test("compaction continuations and stopped-turn followups do not adopt the next input", () => {
  const messages = [user("old", 1), user("compact", 2), answer("stopped", "compact", 3), user("new", 4)]
  const parts = (id: string): Part[] =>
    id === "compact" ? [{ id: "c", messageID: id, sessionID: "session", type: "compaction", auto: true }] : [human(id)]
  expect(displayTurnOwners(messages, parts).get("compact")).toBe("old")
})

test("unhydrated roots and cross-session sources never lend a newer owner", () => {
  const messages = [user("old", 1), user("loading", 3), user("followup", 4)]
  const parts = (id: string) => (id === "loading" ? [] : id === "followup" ? [text(id)] : [human(id)])
  expect(displayTurnOwners(messages, parts).get("followup")).toBe("followup")
  const alien = { ...user("alien", 1), sessionID: "other" }
  expect(
    displayTurnOwners([alien, user("followup", 4)], (id) =>
      id === "followup" ? [text(id, "alien")] : [human(id)],
    ).get("followup"),
  ).toBe("followup")
})
