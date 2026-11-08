import { expect, test } from "bun:test"
import { createTimelineFrame } from "./layout-frame"

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

test("741 one layout frame measures each connected row once before following", async () => {
  const a = document.createElement("div")
  const b = document.createElement("div")
  document.body.append(a, b)
  const calls: string[] = []
  const frame = createTimelineFrame({
    measure: (element) => {
      calls.push(element === a ? "a" : "b")
      frame.follow()
    },
    follow: () => {
      calls.push("follow")
    },
    shouldFollow: () => true,
  })
  frame.measure(a)
  frame.measure(a)
  frame.measure(b)
  frame.follow()
  frame.follow()
  await nextFrame()
  expect(calls).toEqual(["a", "b", "follow"])
  frame.dispose()
  a.remove()
  b.remove()
})

test("741 a user gesture cancels pending follow and explicit resume can clear its hash before flush", async () => {
  let allowed = true
  let calls = 0
  const frame = createTimelineFrame({
    measure: () => {},
    follow: () => {
      calls++
    },
    shouldFollow: () => allowed,
  })
  frame.follow()
  allowed = false
  await nextFrame()
  expect(calls).toBe(0)
  frame.follow()
  allowed = true
  await nextFrame()
  expect(calls).toBe(1)
  frame.dispose()
})

test("741 detached rows and a disposed owner cannot schedule stale measurements or following", async () => {
  const element = document.createElement("div")
  document.body.append(element)
  let measures = 0
  let follows = 0
  const frame = createTimelineFrame({
    measure: () => {
      measures++
    },
    follow: () => {
      follows++
    },
    shouldFollow: () => true,
  })
  frame.measure(element)
  element.remove()
  await nextFrame()
  expect(measures).toBe(0)
  frame.follow()
  frame.dispose()
  frame.measure(element)
  frame.follow()
  await nextFrame()
  expect(measures).toBe(0)
  expect(follows).toBe(0)
})
