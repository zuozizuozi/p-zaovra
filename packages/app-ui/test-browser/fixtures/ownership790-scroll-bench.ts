import { Virtualizer, type VirtualItem } from "@tanstack/solid-virtual"
import { shouldAdjustTimelineSize } from "../../src/pages/session/timeline/virtual-items"

function sample(after: boolean) {
  const started = performance.now()
  let writes = 0
  let size = 0
  for (let index = 0; index < 30; index++) {
    const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: 100,
      getScrollElement: () => null,
      estimateSize: () => 1000,
      initialOffset: 10000,
      initialRect: { width: 800, height: 600 },
      scrollToFn: () => {
        writes++
      },
      observeElementRect: () => {},
      observeElementOffset: () => {},
    })
    instance.getVirtualItems()
    instance.scrollDirection = "backward"
    instance.itemSizeCache.set(3, 1000)
    instance.shouldAdjustScrollPositionOnItemSizeChange = after
      ? (item) => shouldAdjustTimelineSize(item, instance)
      : (item: VirtualItem) => instance.range !== null && item.index < instance.range.startIndex
    for (let turn = 0; turn < 100; turn++) {
      instance.resizeItem(3, 60)
      instance.resizeItem(3, 1000)
    }
    size += instance.getTotalSize()
  }
  return { ms: performance.now() - started, writes, size }
}
const result = [false, true].map((after) => {
  for (let index = 0; index < 3; index++) sample(after)
  const samples = Array.from({ length: 21 }, () => {
    Bun.gc(true)
    return sample(after)
  })
  const values = samples.map((x) => x.ms).toSorted((a, b) => a - b)
  return { after, median: values[10], p95: values[19], samples }
})
console.log(
  JSON.stringify(
    {
      scope:
        "actual Virtualizer with production reading guard; 30 instances/100 rows/200 repeated measured upper-row resizes, non-DOM backward mode; no full window/prepend DOM/native performance claim",
      warmups: 3,
      samples: 21,
      result,
    },
    null,
    2,
  ),
)
