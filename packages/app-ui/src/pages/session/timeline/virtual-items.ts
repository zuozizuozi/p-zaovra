import type { VirtualItem, Virtualizer } from "@tanstack/solid-virtual"

export function filterVirtualIndexes(indexes: number[], count: number) {
  return indexes.filter((index) => index >= 0 && index < count)
}

export function shouldAdjustTimelineSize(
  item: VirtualItem,
  instance: Pick<Virtualizer<HTMLDivElement, HTMLDivElement>, "range" | "scrollDirection" | "itemSizeCache">,
) {
  // Preserve first measurements while matching the virtualizer backward-scroll guard.
  if (instance.scrollDirection === "backward" && instance.itemSizeCache.has(item.key)) return false
  const first = instance.range?.startIndex
  return first !== undefined && item.index < first
}
