import { describe, expect, test } from "bun:test"
import { createImeKeyOwnership } from "./ime-key-ownership"

describe("IME key ownership", () => {
  test("keeps browser composition Enter and Escape with the IME", () => {
    const ime = createImeKeyOwnership()
    for (const key of ["Enter", "Escape"]) {
      const event = new KeyboardEvent("keydown", { key, isComposing: true, cancelable: true })
      expect(ime.owns(event)).toBe(true)
      expect(event.defaultPrevented).toBe(false)
    }
  })

  test("recognizes legacy IME keyCode 229 without the browser flag", () => {
    const event = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229 })
    expect(event.keyCode).toBe(229)
    expect(createImeKeyOwnership().owns(event)).toBe(true)
  })

  test("tracks the composition lifecycle when keyboard flags are missing", () => {
    const ime = createImeKeyOwnership()
    ime.start()
    for (const key of ["Enter", "Escape", "Tab", "ArrowDown", " "]) {
      expect(ime.owns(new KeyboardEvent("keydown", { key }))).toBe(true)
    }
    ime.end()
    expect(ime.owns(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false)
    expect(ime.owns(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false)
  })

  test("keeps editors independent and permits the next normal Enter", () => {
    const first = createImeKeyOwnership()
    const second = createImeKeyOwnership()
    const enter = new KeyboardEvent("keydown", { key: "Enter" })
    first.start()
    expect(first.owns(enter)).toBe(true)
    expect(second.owns(enter)).toBe(false)
    first.end()
    expect(first.owns(enter)).toBe(false)
    second.start()
    expect(first.owns(enter)).toBe(false)
    expect(second.owns(enter)).toBe(true)
  })
})
