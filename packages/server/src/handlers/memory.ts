import { Location } from "@zaovra-ai/core/location"
import { MemoryStore } from "@zaovra-ai/core/memory/store"
import { MemoryTidy } from "@zaovra-ai/core/memory/tidy"
import { MemoryTidyError } from "@zaovra-ai/protocol/groups/memory"
import { Memory } from "@zaovra-ai/schema/memory"
import { Context, Effect, Layer } from "effect"
import { MemoryTidyStore } from "@zaovra-ai/core/memory/tidy-store"
import { MemoryTidyTasks } from "@zaovra-ai/core/memory/tidy-tasks"
import { SessionV2 } from "@zaovra-ai/core/session"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

const scope = (layer: "project" | "user" | undefined) =>
  layer === "user"
    ? Effect.succeed(Memory.Scope.user)
    : Location.Service.use((location) =>
        MemoryStore.Service.use((store) =>
          store.scope({ project: location.project.id, directory: location.directory }),
        ),
      )

export const MemoryHandler = HttpApiBuilder.group(Api, "server.memory", (handlers) =>
  Effect.gen(function* () {
    // Keep task ownership global. A Location graph cannot depend on SessionV2,
    // which itself resolves that graph when a Session drain starts.
    const context = yield* Effect.context<
      MemoryStore.Service | MemoryTidyStore.Service | MemoryTidyTasks.Service | SessionV2.Service
    >()
    const tidyLayer = MemoryTidy.layer.pipe(
      Layer.provide(
        Layer.succeedContext(
          Context.pick(
            MemoryStore.Service,
            MemoryTidyStore.Service,
            MemoryTidyTasks.Service,
            SessionV2.Service,
          )(context),
        ),
      ),
    )
    return handlers
      .handle(
        "memory.prepareTidy",
        Effect.fn(function* (ctx) {
          const tidy = yield* MemoryTidy.Service
          return { data: taskView(yield* tidy.prepare(ctx.payload).pipe(Effect.mapError(tidyError))) }
        }, Effect.provide(tidyLayer)),
      )
      .handle(
        "memory.listTidy",
        Effect.fn(function* (ctx) {
          const tidy = yield* MemoryTidy.Service
          return { data: (yield* tidy.list(ctx.query.layer)).map(taskView) }
        }, Effect.provide(tidyLayer)),
      )
      .handle(
        "memory.getTidy",
        Effect.fn(function* (ctx) {
          const tidy = yield* MemoryTidy.Service
          return { data: taskView(yield* tidy.get(ctx.params.id, ctx.query.layer).pipe(Effect.mapError(tidyError))) }
        }, Effect.provide(tidyLayer)),
      )
      .handle(
        "memory.startTidy",
        Effect.fn(function* (ctx) {
          const tidy = yield* MemoryTidy.Service
          return { data: taskView(yield* tidy.start(ctx.params.id, ctx.query.layer).pipe(Effect.mapError(tidyError))) }
        }, Effect.provide(tidyLayer)),
      )
      .handle(
        "memory.cancelTidy",
        Effect.fn(function* (ctx) {
          const tidy = yield* MemoryTidy.Service
          return { data: taskView(yield* tidy.cancel(ctx.params.id, ctx.query.layer).pipe(Effect.mapError(tidyError))) }
        }, Effect.provide(tidyLayer)),
      )
      .handle(
        "memory.recovery",
        Effect.fn(function* () {
          const store = yield* MemoryStore.Service
          const location = yield* Location.Service
          return { data: yield* store.recovery({ project: location.project.id, directory: location.directory }) }
        }),
      )
      .handle(
        "memory.resolveRecovery",
        Effect.fn(function* (ctx) {
          const store = yield* MemoryStore.Service
          const location = yield* Location.Service
          const place = { project: location.project.id, directory: location.directory }
          const accepted = yield* store.resolveRecovery(place, ctx.payload)
          return { accepted, data: yield* store.recovery(place) }
        }),
      )
      .handle(
        "memory.list",
        Effect.fn(function* (ctx) {
          const store = yield* MemoryStore.Service
          return { data: yield* store.list(yield* scope(ctx.query.layer)) }
        }),
      )
      .handle(
        "memory.create",
        Effect.fn(function* (ctx) {
          const store = yield* MemoryStore.Service
          const note = yield* store.write({
            scope: yield* scope(ctx.payload.layer),
            kind: ctx.payload.kind,
            text: ctx.payload.text,
            origin: "user",
            status: "verified",
            verification: "written by the user",
          })
          return { data: note ?? null }
        }),
      )
      .handle(
        "memory.update",
        Effect.fn(function* (ctx) {
          const store = yield* MemoryStore.Service
          return { data: (yield* store.edit(ctx.params.id, ctx.payload)) ?? null }
        }),
      )
      .handle(
        "memory.remove",
        Effect.fn(function* (ctx) {
          const store = yield* MemoryStore.Service
          yield* store.remove(ctx.params.id)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "memory.clear",
        Effect.fn(function* (ctx) {
          const store = yield* MemoryStore.Service
          yield* store.clear(yield* scope(ctx.query.layer))
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)

function taskView(view: MemoryTidy.View): Memory.TidyTask {
  return {
    id: view.run.id,
    requestID: view.run.request_id,
    sessionID: view.run.session_id,
    layer: view.run.scope === Memory.Scope.user ? "user" : "project",
    directory: view.run.directory,
    model: view.run.model,
    tokens: view.run.token_limit,
    dailyTokens: view.run.daily_limit,
    state: view.run.state,
    executing: view.executing,
    usage: view.usage,
    time: { created: view.run.time_created, finished: view.run.time_finished },
  }
}

function tidyError(error: { reason: MemoryTidyError["reason"] }) {
  const messages = {
    invalid: "整理请求或预算无效。",
    conflict: "同一次确认的参数已改变，请重新确认。",
    unauthorized: "整理授权已失效；请检查记忆开关、目录、模型及旧资料恢复状态。",
    limit: "整理预算不足，未发送新请求。",
    duplicate: "该整理尝试已经处理。",
    missing: "当前范围没有此整理任务。",
    busy: "此范围已有整理任务，或存储正忙；请查看现有任务后重试。",
  }
  return new MemoryTidyError({ reason: error.reason, message: messages[error.reason] })
}
