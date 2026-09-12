import { expect, test } from "bun:test"
import type { Page, Route } from "@playwright/test"
import { mockZaovraServer } from "../../utils/mock-server"

test("serves V2 message envelopes and follows opaque pagination cursors", async () => {
  let handler: ((route: Route) => Promise<void>) | undefined
  const before: (string | undefined)[] = []
  await mockZaovraServer(
    {
      route: (_url: string, callback: (route: Route) => Promise<void>) => {
        handler = callback
        return Promise.resolve()
      },
    } as unknown as Page,
    {
      provider: {},
      directory: "C:/Zaovra",
      project: {},
      sessions: [{ id: "session" }],
      pageMessages: (_sessionID, _limit, cursor) => {
        before.push(cursor)
        return {
          items: [
            {
              info: { id: "msg_user", role: "user", time: { created: 1 } },
              parts: [{ id: "text", type: "text", text: "hello" }],
            },
          ],
          cursor: cursor ? undefined : "msg_previous",
        }
      },
    },
  )
  const request = async (path: string) => {
    let body = ""
    await handler!({
      request: () => ({ url: () => `http://127.0.0.1:4096${path}` }),
      fulfill: (input: { body: string }) => {
        body = input.body
        return Promise.resolve()
      },
    } as unknown as Route)
    return JSON.parse(body) as { data: unknown[]; cursor: { next?: string } }
  }
  const first = await request("/api/session/session/message?order=desc")
  expect(first.data).toEqual([
    { id: "msg_user", type: "user", time: { created: 1 }, text: "hello", files: [], agents: [] },
  ])
  expect(first.cursor.next).toBeDefined()
  const second = await request(`/api/session/session/message?cursor=${first.cursor.next}`)
  expect(before).toEqual([undefined, "msg_previous"])
  expect(second.cursor).toEqual({})
})

test("applies message latency after a list response gate is released", async () => {
  const events: string[] = []
  const gate = Promise.withResolvers<void>()
  let handler: ((route: Route) => Promise<void>) | undefined
  const page = {
    route: (_url: string, callback: (route: Route) => Promise<void>) => {
      handler = callback
      return Promise.resolve()
    },
  } as unknown as Page
  await mockZaovraServer(page, {
    provider: {},
    directory: "C:/Zaovra",
    project: {},
    sessions: [{ id: "session" }],
    messageDelay: 25,
    beforeMessagesResponse: () => {
      events.push("before")
      return gate.promise
    },
    onMessages: (request) => events.push(request.phase),
    pageMessages: () => {
      events.push("page")
      return { items: [] }
    },
  })

  const response = handler!({
    request: () => ({ url: () => "http://127.0.0.1:4096/session/session/message" }),
    fulfill: () => {
      events.push("fulfill")
      return Promise.resolve()
    },
  } as unknown as Route)
  expect(events).toEqual(["start", "before"])

  const released = performance.now()
  gate.resolve()
  await response
  expect(performance.now() - released).toBeGreaterThanOrEqual(20)
  expect(events).toEqual(["start", "before", "page", "end", "fulfill"])
})
