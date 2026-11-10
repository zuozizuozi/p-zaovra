import { expect, test } from "bun:test"
import { batch, createComponent, createComputed, createMemo, createRoot, createSignal, For } from "solid-js"
import { createVirtualizer, type VirtualItem } from "@tanstack/solid-virtual"
import { TimelineRow } from "../src/pages/session/timeline/timeline-row"
const virtualItems = await import("../src/pages/session/timeline/virtual-items")
const bind = "bindTimelineRows" in virtualItems ? virtualItems.bindTimelineRows : undefined

const source = await Bun.file(new URL("../src/pages/session/timeline/message-timeline.tsx", import.meta.url)).text()
// Exercise the component's actual memo/child closures without replacing the
// virtualizer or duplicating the binding algorithm in the regression fixture.
const binding = source.match(
  /  const (?:virtualItemByKey|virtualRows) = createMemo[^\n]*\([\s\S]*?(?=  createEffect\()/,
)?.[0]
const child = source.match(
  /  function VirtualTimelineRow\([\s\S]*?\n    (const initial[\s\S]*?)(?=    const tool)/,
)?.[1]
if (!binding || !child) throw new Error("Timeline binding fixture no longer matches the component")
const compile = new Bun.Transpiler({ loader: "ts" })
const componentBinding = new Function(
  "createMemo",
  "virtualizer",
  "timelineRowByKey",
  "bindTimelineRows",
  compile.transformSync(`${binding}
  return { keys: virtualRowKeys, mount: (props: { rowKey: string }) => {
    ${child}
    return { item, row }
  } }`),
) as (
  memo: typeof createMemo,
  virtualizer: ReturnType<typeof createVirtualizer<HTMLDivElement, HTMLDivElement>>,
  rows: () => Map<string, TimelineRow.TimelineRow>,
  bind: unknown,
) => {
  keys: () => string[]
  mount: (props: { rowKey: string }) => { item: () => VirtualItem; row: () => TimelineRow.TimelineRow }
}

for (const count of [10, 100])
  test(`811 projection replacement and stale measurement publish a complete viewport (${count})`, () => {
    createRoot((dispose) => {
      const initial = Array.from(
        { length: 100 },
        (_, index) => new TimelineRow.UserMessage({ userMessageID: `old:${index}`, anchor: true }),
      )
      const [rows, setRows] = createSignal(initial)
      const byKey = createMemo(() => new Map(rows().map((row) => [TimelineRow.key(row), row])))
      const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
        get count() {
          return rows().length
        },
        getScrollElement: () => null,
        initialRect: { width: 720, height: 600 },
        initialOffset: 9400,
        estimateSize: () => 100,
        overscan: 0,
        get getItemKey() {
          const snapshot = rows()
          return (index: number) => (snapshot[index] ? TimelineRow.key(snapshot[index]) : `removed:${index}`)
        },
        scrollToFn: () => {},
        observeElementRect: () => {},
        observeElementOffset: () => {},
      })
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
      const view = componentBinding(createMemo, virtualizer, byKey, bind)
      const rendered = createComponent(For, {
        get each() {
          return view.keys()
        },
        children: (key: string) => ({ key, ...view.mount({ rowKey: key }), identity: {} }),
      }) as unknown as () => {
        key: string
        row: () => TimelineRow.TimelineRow
        item: () => VirtualItem
        identity: object
      }[]
      createComputed(() => rendered().forEach((entry) => entry.row()._tag))
      const before = [...rendered()]
      const beforeItems = before.map((entry) => ({ ...entry.item() }))
      let during: string[] = []
      batch(() => {
        setRows(
          Array.from({ length: count }, (_, index) =>
            index >= 94 ? initial[index] : new TimelineRow.UserMessage({ userMessageID: `new:${index}`, anchor: true }),
          ),
        )
        virtualizer.resizeItem(90, 1000)
        during = rendered().map((entry) => {
          expect(entry.row()._tag).toBe("UserMessage")
          return entry.key
        })
        expect(before.map((entry) => entry.item())).toEqual(beforeItems)
      })
      expect(during).toEqual(before.map((entry) => entry.key))
      expect(virtualizer.options.count).toBe(count)
      expect(rendered().length).toBe(6)
      expect(rendered().every((entry) => byKey().get(entry.key) === entry.row())).toBe(true)
      if (count === 100) expect(rendered().every((entry, index) => entry === before[index])).toBe(true)
      if (count === 10)
        expect(view.keys()).toEqual(Array.from({ length: 6 }, (_, index) => `user-message:new:${index + 4}`))
      setRows([])
      expect(view.keys()).toEqual([])
      expect(rendered()).toEqual([])
      dispose()
    })
  })
