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
import { WorkControllerTable, WorkControllerDispatchTable, WorkGoalTable, WorkLeaseTable, WorkTaskTable, WorkWorkerTable } from "@zaovra-ai/core/work/sql"
import { eq } from "drizzle-orm"
import { DateTime, Effect, ManagedRuntime } from "effect"

test.each([
  "idle",
  "queued-pause",
  "approval-race",
  "queued-wake",
  "leased-wake",
  "leased-continue",
  "wake-paused",
  "cancel-approval",
  "cancel-paused",
])(
  "merge approval dispatch: %s",
  async (mode) => {
    const traceStart = Date.now()
    const traced = new Map<string, string>()
    const trace = (phase: string, state: Record<string, unknown>) => {
      const value = JSON.stringify(state)
      if (traced.get(phase) === value) return
      traced.set(phase, value)
      console.info("merge-wake-trace", { mode, phase, elapsedMs: Date.now() - traceStart, ...state })
    }
    // This separate read-only runtime adds no Controller/Worker or projector scope.
    const observations = ManagedRuntime.make(AppNodeBuilder.build(Database.node), { memoMap })
    await using observationCleanup = { [Symbol.asyncDispose]: () => observations.dispose() }
    const observe = async (phase: string) => {
      const state = await observations.runPromise(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const goalID = Work.GoalID.make(id)
          const goal = yield* db.select({ workerID: WorkGoalTable.worker_id, status: WorkGoalTable.status }).from(WorkGoalTable).where(eq(WorkGoalTable.id, goalID)).get().pipe(Effect.orDie)
          const tasks = yield* db.select({ id: WorkTaskTable.id, status: WorkTaskTable.status }).from(WorkTaskTable).where(eq(WorkTaskTable.goal_id, goalID)).all().pipe(Effect.orDie)
          const dispatch = yield* db.select().from(WorkControllerDispatchTable).where(eq(WorkControllerDispatchTable.goal_id, goalID)).get().pipe(Effect.orDie)
          const lease = yield* db.select().from(WorkLeaseTable).where(eq(WorkLeaseTable.goal_id, goalID)).get().pipe(Effect.orDie)
          const controllers = yield* db.select({ id: WorkControllerTable.id, runtimeID: WorkControllerTable.runtime_id, draining: WorkControllerTable.draining, heartbeatAt: WorkControllerTable.time_heartbeat, expiresAt: WorkControllerTable.expires_at }).from(WorkControllerTable).all().pipe(Effect.orDie)
          const workers = yield* db.select({ id: WorkWorkerTable.id, mode: WorkWorkerTable.execution_mode, draining: WorkWorkerTable.draining, heartbeatAt: WorkWorkerTable.time_heartbeat, expiresAt: WorkWorkerTable.expires_at, capabilities: WorkWorkerTable.capabilities }).from(WorkWorkerTable).all().pipe(Effect.orDie)
          return { now: Date.now(), goal: goal?.status, tasks, workerID: goal?.workerID, dispatch, lease, controllers, workers }
        }),
      )
      console.info("merge-wake-ownership", { mode, phase, calls, remainingMs: deadline - Date.now(), ...state })
    }
    const pause =
      mode === "queued-pause" || mode === "approval-race" || mode === "wake-paused" || mode === "cancel-paused"
    const cancel = mode === "cancel-approval" || mode === "cancel-paused"
    const abort = new AbortController()
    const disconnected = Promise.withResolvers<void>()
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
    await using http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        request.signal.addEventListener("abort", () => disconnected.resolve(), { once: true })
        return app.fetch(request)
      },
    })
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
    const observedWaits = new Set<string>()
    const observeWait = async (phase: string) => {
      if (deadline - Date.now() > 1000 || observedWaits.has(phase)) return
      observedWaits.add(phase)
      await observe(phase)
    }
    trace("budget-start", { calls, remainingMs: deadline - Date.now() })
    await observe("resume-admitted")
    let pending = false
    while (Date.now() < deadline) {
      await observeWait("pending-before-timeout")
      const state = await (await request(`/api/work/${id}`)).json()
      const active = await (await request("/api/work/active")).json()
      trace("pending-state", { goal: state.data.goal.status, task: state.data.tasks[0].status, active: Boolean(active.data[id]), calls })
      if (state.data.tasks[0].status === "merging" && !active.data[id]) {
        pending = true
        break
      }
      await sleep(50)
    }
    trace("pending-result", { pending, calls, remainingMs: deadline - Date.now() })
    if (!pending) await observe("pending-expired")
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
            (mode !== "approval-race" && !cancel) ||
            event.type !== Work.Event.TaskMergeReviewed.type ||
            event.durable?.aggregateID !== id
          )
            return Effect.void
          // publish awaits listeners after commit and before decide writes its signal.
          // Pause through the real API at that exact boundary, without mocking services.
          return Effect.promise(async () => {
            if (pause) await request(`/api/work/${id}/pause`, {})
            if (cancel) {
              abort.abort()
              await disconnected.promise
            }
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
    trace("runtime-ready", { calls, remainingMs: deadline - Date.now() })
    const goalID = Work.GoalID.make(id)
    const leased = mode === "leased-wake" || mode === "leased-continue"
    const prior = mode === "leased-continue" ? "continue" : "wake"
    if (mode !== "idle")
      await runtime.runPromise(WorkController.Service.use((controller) => controller.setDraining(true)))
    const held = leased
      ? await runtime.runPromise(
          WorkController.Service.use((controller) =>
            Effect.gen(function* () {
              yield* controller.signal(goalID, prior)
              yield* controller.setDraining(false)
              const claim = (yield* controller.claim({ goalID }))[0]
              yield* controller.setDraining(true)
              return claim
            }),
          ),
        )
      : undefined
    if (leased) {
      expect(held).toBeDefined()
      // Real review read under a held dispatch; retain its pre-approval result.
      expect((await (await request(`/api/work/${id}/merge/${task}`)).json()).approved).toBe(false)
    }
    if (mode === "queued-wake" || mode === "wake-paused")
      await runtime.runPromise(WorkController.Service.use((controller) => controller.signal(goalID, "wake")))
    if (cancel) {
      trace("cancel-request", { calls, remainingMs: deadline - Date.now() })
      await fetch(`http://127.0.0.1:${http.port}/api/work/${id}/merge/${task}`, {
        headers,
        method: "POST",
        body: JSON.stringify({ token: review.token, approved: true }),
        signal: abort.signal,
      }).then(
        () => {
          throw new Error("approval request was not cancelled")
        },
        (error) => {
          expect(error.name).toBe("AbortError")
        },
      )
      trace("cancel-aborted", { calls, remainingMs: deadline - Date.now() })
      while (Date.now() < deadline) {
        await observeWait("cancel-dispatch-before-timeout")
        const dispatches = await runtime.runPromise(
          WorkController.Service.use((controller) => controller.dispatches(goalID)),
        )
        trace("dispatch-state", { calls, dispatches: dispatches.map((dispatch) => ({ signal: dispatch.signal, status: dispatch.status, revision: dispatch.revision })) })
        if (dispatches.some((dispatch) => dispatch.signal === (pause ? "interrupt" : "continue"))) break
        await sleep(25)
      }
      if (Date.now() >= deadline) await observe("cancel-dispatch-expired")
      expect(
        await runtime.runPromise(WorkController.Service.use((controller) => controller.dispatches(goalID))),
      ).toMatchObject([{ signal: pause ? "interrupt" : "continue", status: "pending" }])
      if (!pause) await runtime.runPromise(WorkController.Service.use((controller) => controller.setDraining(false)))
    } else {
      await request(`/api/work/${id}/merge/${task}`, { token: review.token, approved: true })
    }
    if (leased || mode === "queued-wake") {
      const pending = await runtime.runPromise(
        WorkController.Service.use((controller) => controller.dispatches(goalID)),
      )
      expect(pending[0]?.signal).toBe(prior)
      if (held) {
        expect(pending[0]!.revision).toBe(held.revision + 1)
        await runtime.runPromise(WorkController.Service.use((controller) => controller.run(held, Effect.void)))
        expect(
          (await runtime.runPromise(WorkController.Service.use((controller) => controller.dispatches(goalID))))[0]
            ?.status,
        ).toBe("pending")
      }
      await runtime.runPromise(WorkController.Service.use((controller) => controller.setDraining(false)))
    }
    if (pause) {
      const goalID = Work.GoalID.make(id)
      const queued = await runtime.runPromise(WorkController.Service.use((controller) => controller.dispatches(goalID)))
      expect(queued).toMatchObject([
        {
          signal:
            mode === "approval-race" || mode === "cancel-paused"
              ? "interrupt"
              : mode === "wake-paused"
                ? "wake"
                : "continue",
          status: "pending",
        },
      ])
      // Real durable pause transitions, with the advisory dispatch already queued.
      // Hold dispatch until after the pause projection, deterministically exercising
      // the consumer boundary rather than relying on timers to win a race.
      if (mode === "wake-paused") {
        // Work.pause also records interrupt; direct pause projections alone omit
        // the product entry point's dispatch invariant (audit revision 119).
        await request(`/api/work/${id}/pause`, {})
        expect(
          await runtime.runPromise(WorkController.Service.use((controller) => controller.dispatches(goalID))),
        ).toMatchObject([{ signal: "interrupt", status: "pending" }])
      }
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
        await observeWait("pause-settlement-before-timeout")
        const dispatches = await runtime.runPromise(
          WorkController.Service.use((controller) => controller.dispatches(goalID)),
        )
        if (dispatches[0]?.status === "settled") {
          settled = true
          break
        }
        await sleep(25)
      }
      if (!settled) await observe("pause-settlement-expired")
      expect(settled).toBe(true)
      if (mode === "wake-paused")
        console.info("wake-paused boundary", {
          goalStatus: (await (await request(`/api/work/${id}`)).json()).data.goal.status,
          applied: await Bun.file(path.join(tmp.path, "feature.txt")).exists(),
          providerCallsAfterApproval: calls - before,
        })
      expect((await (await request(`/api/work/${id}`)).json()).data.goal.status).toBe("paused")
      expect(await Bun.file(path.join(tmp.path, "feature.txt")).exists()).toBe(false)
      expect(calls).toBe(before)
      await request(`/api/work/${id}/resume`, {})
      await observe("resume-after-pause")
    }
    trace("completion-wait-start", { calls, remainingMs: deadline - Date.now() })
    let completed = false
    while (Date.now() < deadline) {
      await observeWait("completion-before-timeout")
      const state = await (await request(`/api/work/${id}`)).json()
      trace("completion-state", { goal: state.data.goal.status, task: state.data.tasks[0].status, calls })
      if (state.data.goal.status === "completed") {
        completed = true
        break
      }
      await sleep(50)
    }
    trace("completed-result", { completed, calls, remainingMs: deadline - Date.now() })
    if (!completed) await observe("completion-expired")
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
