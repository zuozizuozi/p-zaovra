import { afterEach, describe, expect, test } from "bun:test"
import { handleNotificationClick, setNavigate } from "./notification-click"

describe("notification click", () => {
  afterEach(() => {
    setNavigate(undefined)
  })

  test("navigates via registered navigate function", () => {
    const calls: string[] = []
    setNavigate((href) => calls.push(href))
    handleNotificationClick("/abc/session/123")
    expect(calls).toEqual(["/abc/session/123"])
  })

  test("focuses a request that arrives after navigation", async () => {
    setNavigate(() => {})
    handleNotificationClick("/abc/session/123#question=que_focus")
    const card = document.createElement("div")
    card.dataset.notificationTarget = "question:que_focus"
    const button = document.createElement("button")
    button.dataset.slot = "question-option"
    card.append(button)
    document.body.append(card)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(document.activeElement).toBe(button)
    handleNotificationClick("/abc/session/123#question=que_focus")
    expect(document.activeElement).toBe(button)
    card.remove()
  })

  test("does not navigate when href is missing", () => {
    const calls: string[] = []
    setNavigate((href) => calls.push(href))
    handleNotificationClick(undefined)
    expect(calls).toEqual([])
  })

  test("falls back to location.assign without registered navigate", () => {
    handleNotificationClick("/abc/session/123")
    // falls back to window.location.assign — no error thrown
  })
})
