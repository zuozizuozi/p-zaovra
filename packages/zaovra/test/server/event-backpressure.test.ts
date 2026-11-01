import { expect, test } from "bun:test"
import { Effect, Exit, Schema, Stream } from "effect"
import { EventV2 } from "@zaovra-ai/core/event"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { Global } from "@zaovra-ai/core/global"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { GlobalBus } from "../../src/bus/global"
import { globalEventStream } from "../../src/server/routes/instance/httpapi/handlers/global"
import { instanceEventStream } from "../../src/server/routes/instance/httpapi/handlers/event"
import { tmpdir } from "../fixture/fixture"

const Probe = EventV2.define({ type: "test.490.backpressure", schema: { index: Schema.Number } })

test("490 global slow subscriber closes at its bound and unregisters before it is read", async () => {
  const before = GlobalBus.listenerCount("event")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* globalEventStream()
        expect(GlobalBus.listenerCount("event")).toBe(before + 1)
        for (let index = 0; index < 257; index++)
          GlobalBus.emit("event", { payload: { id: `evt_slow_${index}`, type: "test.490", properties: {} } })
        expect(GlobalBus.listenerCount("event")).toBe(before)
        expect(Exit.isFailure(yield* Effect.exit(Stream.runCollect(stream)))).toBe(true)
      }),
    ),
  )
  expect(GlobalBus.listenerCount("event")).toBe(before)
})

test("490 global reconnect replays a bounded gap and requests snapshot reset for a larger gap", async () => {
  const before = GlobalBus.listenerCount("event")
  const anchor = EventV2.ID.create()
  GlobalBus.emit("event", { payload: { id: anchor, type: "test.490", properties: {} } })
  GlobalBus.emit("event", { payload: { id: EventV2.ID.create(), type: "test.490", properties: { index: 1 } } })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* globalEventStream(anchor)
        const replay = yield* Stream.runCollect(stream.pipe(Stream.take(2)))
        expect(replay[0].payload.properties.replay).toBe("applied")
        expect(replay[1].payload.properties.index).toBe(1)
      }),
    ),
  )
  for (let index = 0; index < 257; index++)
    GlobalBus.emit("event", { payload: { id: EventV2.ID.create(), type: "test.490", properties: {} } })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* globalEventStream(anchor)
        const replay = yield* Stream.runCollect(stream.pipe(Stream.take(1)))
        expect(replay[0].payload.properties.replay).toBe("reset")
      }),
    ),
  )
  expect(GlobalBus.listenerCount("event")).toBe(before)
})

test("490 instance filters before enqueue, unregisters on overflow and supports cursor replay", async () => {
  await using tmp = await tmpdir()
  const directory = AbsolutePath.make(tmp.path)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const observed = { calls: 0 }
        const measured: Pick<EventV2.Interface, "listen" | "recentAfter"> = {
          recentAfter: events.recentAfter,
          listen: (listener) =>
            events.listen((event) => Effect.sync(() => observed.calls++).pipe(Effect.andThen(listener(event)))),
        }
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* instanceEventStream(measured, { directory })
            for (let index = 0; index < 300; index++)
              yield* events.publish(
                Probe,
                { index },
                { location: { directory: AbsolutePath.make(`${tmp.path}/other`) } },
              )
            for (let index = 0; index < 257; index++)
              yield* events.publish(Probe, { index }, { location: { directory } })
            const stopped = observed.calls
            yield* events.publish(Probe, { index: 999 }, { location: { directory } })
            expect(observed.calls).toBe(stopped)
            expect(stopped).toBe(557)
            expect(Exit.isFailure(yield* Effect.exit(Stream.runCollect(stream)))).toBe(true)
          }),
        )
        const anchor = yield* events.publish(Probe, { index: 1000 }, { location: { directory } })
        const next = yield* events.publish(Probe, { index: 1001 }, { location: { directory } })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* instanceEventStream(events, { directory }, anchor.id)
            const replay = yield* Stream.runCollect(stream.pipe(Stream.take(2)))
            expect(replay[0].properties).toEqual({ replay: "applied" })
            expect(replay[1].id).toBe(next.id)
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* instanceEventStream(events, { directory }, "missing")
            expect((yield* Stream.runCollect(stream.pipe(Stream.take(1))))[0].properties).toEqual({ replay: "reset" })
          }),
        )
      }),
    ).pipe(Effect.provide(AppNodeBuilder.build(EventV2.node, [[Global.node, Global.layerWith({ data: tmp.path })]]))),
  )
})
