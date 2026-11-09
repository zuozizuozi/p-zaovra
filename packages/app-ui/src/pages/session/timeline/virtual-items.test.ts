import { expect, test } from "bun:test"
import { Virtualizer } from "@tanstack/solid-virtual"
import { shouldAdjustTimelineSize } from "./virtual-items"

function timeline(direction: "backward" | "forward", measured: boolean) {
  const writes: number[] = []
  const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 100,
    getScrollElement: () => null,
    estimateSize: () => 1000,
    initialOffset: 10000,
    initialRect: { width: 800, height: 600 },
    scrollToFn: (offset, options) => writes.push(offset + (options.adjustments ?? 0)),
    observeElementRect: () => {},
    observeElementOffset: () => {},
  })
  instance.getVirtualItems()
  instance.scrollDirection = direction
  if (measured) instance.itemSizeCache.set(3, 1000)
  instance.shouldAdjustScrollPositionOnItemSizeChange = (item) => shouldAdjustTimelineSize(item, instance)
  return { instance, writes }
}

test("backward remeasurement updates geometry without a second scroll compensation", () => {
  const current = timeline("backward", true)
  current.instance.resizeItem(3, 60)
  expect(current.instance.itemSizeCache.get(3)).toBe(60)
  expect(current.writes).toEqual([])
  expect(current.instance.scrollOffset).toBe(10000)
})

test("first measurement above the backward viewport still preserves its anchor", () => {
  const current = timeline("backward", false)
  current.instance.resizeItem(3, 60)
  expect(current.writes).toEqual([9060])
  expect(current.instance.scrollOffset).toBe(9060)
})

test("forward remeasurement above the viewport still compensates its actual delta", () => {
  const current = timeline("forward", true)
  current.instance.resizeItem(3, 60)
  expect(current.writes).toEqual([9060])
  expect(current.instance.scrollOffset).toBe(9060)
})

test("visible rows and an unavailable range cannot pull the reader", () => {
  const current = timeline("forward", true)
  current.instance.resizeItem(10, 60)
  expect(current.writes).toEqual([])
  current.instance.range = null
  expect(shouldAdjustTimelineSize(current.instance.measurementsCache[3]!, current.instance)).toBe(false)
})
