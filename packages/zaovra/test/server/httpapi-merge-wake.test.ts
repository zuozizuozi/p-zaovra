import { $, sleep } from "bun"
import { expect, test } from "bun:test"
import path from "node:path"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { memoMap } from "@zaovra-ai/core/effect/memo-map"
import { WorkController } from "@zaovra-ai/core/work/controller"
import { WorkProjector } from "@zaovra-ai/core/work/projector"
import { EventV2 } from "@zaovra-ai/core/event"
import { Database } from "@zaovra-ai/core/database/database"
import { DurableEventManifest } from "@zaovra-ai/schema/durable-event-manifest"
import { Work } from "@zaovra-ai/schema/work"
import { DateTime, Effect, ManagedRuntime } from "effect"

test.each(["idle", "queued-pause", "approval-race"])(
  "merge approval dispatch: %s",
  async (mode) => {
    const pause = mode !== "idle"
    await using tmp = await tmpdir({ git: true })
    const isolated = path.join(tmp.path, "isolated")
    let calls = 0
    await using provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++
        const data = {
          id: "merge-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta: { role: "assistant", content: '{"criteria":[]}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }
        return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    await Bun.write(path.join(tmp.path, ".gitignore"), "isolated/\n")
    await Bun.write(path.join(tmp.path, "base.txt"), "base")
    await Bun.write(
      path.join(tmp.path, "zaovra.json"),
      JSON.stringify({
        model: "merge-fixture/fixture",
        provider: {
          "merge-fixture": {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
            models: { fixture: { limit: { context: 32000, output: 1024 } } },
          },
        },
      }),
    )
    await $`git add .`.cwd(tmp.path).quiet()
    await $`git -c user.name=Test -c user.email=test@example.test commit -m fixture`.cwd(tmp.path).quiet()
    await $`git worktree add --detach ${isolated}`.cwd(tmp.path).quiet()
    await Bun.write(path.join(isolated, "feature.txt"), "isolated change\n".repeat(6000))
    const app = Server.Default().app
    const headers = { "content-type": "application/json", "x-zaovra-directory": encodeURIComponent(tmp.path) }
    const id = `goal_merge_${Date.now()}`
    const request = async (url: string, body?: unknown) => {
      const response = await app.request(url, {
        headers,
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      })
      expect(response.status, await response.clone().text()).toBeLessThan(300)
      return response
    }
    const created = await (
      await request("/api/work", {
        id,
        location: { directory: tmp.path },
        objective: "Merge fixture",
        acceptanceCriteria: [],
        tasks: [{ title: "Isolated", instructions: "Return a short response", location: { directory: isolated } }],
      })
    ).json()
    const task = created.data.tasks[0].id
    await request(`/api/work/${id}/resume`, {})
    const deadline = Date.now() + 20000
    let pending = false
    while (Date.now() < deadline) {
      const state = await (await request(`/api/work/${id}`)).json()
      const active = await (await request("/api/work/active")).json()
      if (state.data.tasks[0].status === "merging" && !active.data[id]) {
        pending = true
        break
      }
      await sleep(50)
    }
    expect(pending).toBe(true)
    const review = await (await request(`/api/work/${id}/merge/${task}`)).json()
    const before = calls
    const runtime = ManagedRuntime.make(
      AppNodeBuilder.build(LayerNode.group([Database.node, WorkController.node, WorkProjector.node, EventV2.node])),
      { memoMap },
    )
    const unsubscribe = await runtime.runPromise(
      EventV2.Service.use((events) =>
        events.listen((event) => {
          if (
            mode !== "approval-race" ||
            event.type !== Work.Event.TaskMergeReviewed.type ||
            event.durable?.aggregateID !== id
          )
            return Effect.void
          // publish awaits listeners after commit and before decide writes its signal.
          // Pause through the real API at that exact boundary, without mocking services.
          return Effect.promise(async () => {
            await request(`/api/work/${id}/pause`, {})
          })
        }),
      ),
    )
    await using cleanup = {
      [Symbol.asyncDispose]: async () => {
        await runtime.runPromise(WorkController.Service.use((controller) => controller.setDraining(false)))
        await runtime.runPromise(unsubscribe)
        await runtime.dispose()
      },
    }
    if (pause) await runtime.runPromise(WorkController.Service.use((controller) => controller.setDraining(true)))
    await request(`/api/work/${id}/merge/${task}`, { token: review.token, approved: true })
    if (pause) {
      const goalID = Work.GoalID.make(id)
      const queued = await runtime.runPromise(WorkController.Service.use((controller) => controller.dispatches(goalID)))
      expect(queued).toMatchObject([{ signal: mode === "approval-race" ? "interrupt" : "continue", status: "pending" }])
      // Real durable pause transitions, with the advisory dispatch already queued.
      // Hold dispatch until after the pause projection, deterministically exercising
      // the consumer boundary rather than relying on timers to win a race.
      if (mode === "queued-pause")
        await runtime.runPromise(
          Effect.gen(function* () {
            const events = yield* EventV2.Service
            yield* events.publish(Work.Event.GoalPauseRequested, { goalID, timestamp: DateTime.nowUnsafe() })
            yield* events.publish(Work.Event.GoalPaused, { goalID, timestamp: DateTime.nowUnsafe() })
          }),
        )
      const rejected = await app.request(`/api/work/${id}/merge/${task}`, {
        headers,
        method: "POST",
        body: JSON.stringify({ token: review.token, approved: true }),
      })
      expect(rejected.status).toBe(409)
      await runtime.runPromise(WorkController.Service.use((controller) => controller.setDraining(false)))
      let settled = false
      while (Date.now() < deadline) {
        const dispatches = await runtime.runPromise(
          WorkController.Service.use((controller) => controller.dispatches(goalID)),
        )
        if (dispatches[0]?.status === "settled") {
          settled = true
          break
        }
        await sleep(25)
      }
      expect(settled).toBe(true)
      expect((await (await request(`/api/work/${id}`)).json()).data.goal.status).toBe("paused")
      expect(await Bun.file(path.join(tmp.path, "feature.txt")).exists()).toBe(false)
      expect(calls).toBe(before)
      await request(`/api/work/${id}/resume`, {})
    }
    let completed = false
    while (Date.now() < deadline) {
      const state = await (await request(`/api/work/${id}`)).json()
      if (state.data.goal.status === "completed") {
        completed = true
        break
      }
      await sleep(50)
    }
    expect(completed).toBe(true)
    expect((await Bun.file(path.join(tmp.path, "feature.txt")).text()).replaceAll("\r\n", "\n")).toBe(
      "isolated change\n".repeat(6000),
    )
    expect(calls).toBe(before)
    const history = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Database.Service
        return yield* EventV2.readAggregate(db.db, {
          aggregateID: Work.GoalID.make(id),
          limit: 500,
          manifest: DurableEventManifest.WorkDurable,
        })
      }),
    )
    expect(
      history.events.filter((event) => event.type === Work.Event.TaskMerged.type && event.data.taskID === task),
    ).toHaveLength(1)
  },
  45000,
)
