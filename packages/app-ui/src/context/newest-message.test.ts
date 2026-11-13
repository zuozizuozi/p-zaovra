import { expect, test } from "bun:test"
import type { Message } from "@zaovra-ai/sdk/v2/client"
import { newestMessage } from "./newest-message"

const message = (id: string, role: "user" | "assistant", created: number) =>
  ({ id, role, sessionID: "ses", time: { created } }) as Message

test("the reply that ended a turn is newest even though a command record sorts after it by ID", () => {
  // The store's order: by ID. A command record's ID starts with msg_bash_ and sorts last.
  const stored = [
    message("msg_1d3fa624c001", "user", 1),
    message("msg_1d3fa809b001", "assistant", 2),
    message("msg_1d3fa9130001", "assistant", 4),
    message("msg_bash_msg_1d3fa809b001_call_00", "user", 3),
  ]
  expect(stored.at(-1)?.role).toBe("user")
  expect(newestMessage(stored)).toMatchObject({ id: "msg_1d3fa9130001", role: "assistant" })
})

test("nothing is newest in an empty or unloaded session", () => {
  expect(newestMessage([])).toBeUndefined()
  expect(newestMessage(undefined)).toBeUndefined()
})
