import type { VirtualItem, Virtualizer } from "@tanstack/solid-virtual"
import type { TimelineRow } from "./timeline-row"

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

export function bindTimelineRows(
  items: readonly VirtualItem[],
  rows: ReadonlyMap<string, TimelineRow.TimelineRow>,
  previous: Map<string, { item: VirtualItem; row: TimelineRow.TimelineRow }>,
) {
  const entries = items.flatMap((item) => {
    if (typeof item.key !== "string") return []
    const row = rows.get(item.key)
    if (!row) return []
    return [[item.key, { item: { ...item }, row }] as const]
  })
  // A measurement notification may still use the previous projection inside a batch.
  // Publish a complete paired viewport; keep the last one until options catch up.
  if (entries.length !== items.length) return previous
  return new Map(entries)
}
