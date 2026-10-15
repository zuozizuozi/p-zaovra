import { afterEach, describe, expect, test } from "bun:test"
import { handleNotificationClick, setNavigate } from "./notification-click"

describe("notification click", () => {
  for (const kind of ["question", "permission"])
    test(`closes settings even when the ${kind} notification route is unchanged`, async () => {
      const panel = document.createElement("div")
      panel.style.display = "none"
      const card = document.createElement("div")
      card.dataset.notificationTarget = `${kind}:same`
      const button = document.createElement("button")
      card.append(button)
      panel.append(card)
      document.body.append(panel)
      let closed = 0
      const close = () => {
        closed++
        panel.style.display = "block"
      }
      window.addEventListener("zaovra:settings-close", close)
      setNavigate(() => {})
      try {
        handleNotificationClick(`/session/current#${kind}=same`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(closed).toBe(1)
        expect(document.activeElement).toBe(button)
        panel.style.display = "none"
        handleNotificationClick(`/session/current#${kind}=same`)
        expect(closed).toBe(2)
        expect(document.activeElement).toBe(button)
      } finally {
        window.removeEventListener("zaovra:settings-close", close)
        panel.remove()
      }
    })
  test("waits for a hidden request to become visible before focusing", async () => {
    const panel = document.createElement("div")
    panel.style.display = "none"
    const card = document.createElement("div")
    card.dataset.notificationTarget = "permission:later"
    const button = document.createElement("button")
    card.append(button)
    panel.append(card)
    document.body.append(panel)
    setNavigate(() => {})
    try {
      handleNotificationClick("/session/current#permission=later")
      expect(document.activeElement).not.toBe(button)
      panel.style.display = "block"
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(document.activeElement).toBe(button)
    } finally {
      panel.remove()
    }
  })
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
