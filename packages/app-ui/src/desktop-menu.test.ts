import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU } from "./desktop-menu"

describe("desktop menu", () => {
  test("unifies legacy feedback links into one local entry while keeping raw logs separate", () => {
    const items = DESKTOP_MENU.find((menu) => menu.id === "help")!.items!
    expect(items.filter((item) => item.type === "item" && item.command === "feedback.open")).toHaveLength(1)
    expect(items.some((item) => item.type === "item" && item.command === "logs.export")).toBe(true)
    expect(items.some((item) => item.type === "item" && /discord|mailto/i.test(item.href ?? ""))).toBe(false)
  })
  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.label === "Export Logs...",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })
})
