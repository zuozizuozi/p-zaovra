export * as MemoryTidyCount from "./tidy-count"

import { createHash } from "node:crypto"
import { eq, and } from "drizzle-orm"
import { Effect, Option } from "effect"
import { Headers } from "effect/unstable/http"
import { LLMRequest, type Model } from "@zaovra-ai/llm"
import { OpenAIResponses } from "@zaovra-ai/llm/protocols/openai-responses"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { Credential } from "../credential"
import { Integration } from "../integration"
import type { Database } from "../database/database"
import type { ModelV2 } from "../model"
import { SessionOutputRecovery } from "../session/output-recovery"
import { SessionRunnerModel } from "../session/runner/model"
import { MemoryAutomaticRunTable, MemoryAutomaticTable, MemoryTidyCountTable } from "./automatic.sql"

export function supported(model: Model) {
  return (
    model.route.protocol === "openai-responses" &&
    model.route.transport === OpenAIResponses.httpTransport &&
    model.route.body === OpenAIResponses.route.body &&
    model.route.endpoint.path === OpenAIResponses.PATH
  )
}

/** The opaque binding stays on the host. Never persist or return the credential or headers. */
export const binding = Effect.fn("MemoryTidyCount.binding")(function* (ref: ModelV2.Ref, model: Model) {
  if (!supported(model)) return undefined
  const headers = yield* model.route.auth
    .apply({
      request: new LLMRequest({ model, messages: [], system: [], tools: [] }),
      method: "POST",
      url: model.route.endpoint.baseURL ?? "",
      body: "",
      headers: Headers.fromInput(model.route.defaults.headers ?? {}),
    })
    .pipe(Effect.option)
  if (Option.isNone(headers)) return undefined
  return createHash("sha256")
    .update(
      JSON.stringify([
        "memory-tidy-count/v1",
        ref.providerID,
        ref.id,
        ref.variant ?? "default",
        SessionOutputRecovery.identity(model),
        Object.entries(headers.value).sort(([first], [second]) => first.localeCompare(second)),
      ]),
    )
    .digest("hex")
})

/** Use only local credential state: opening settings and scheduler checks must never refresh OAuth or call a model. */
export const configuredBinding = Effect.fn("MemoryTidyCount.configuredBinding")(function* (ref: ModelV2.Ref) {
  const catalog = yield* Catalog.Service
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const agents = yield* AgentV2.Service
  const selected = (yield* catalog.model.available()).find(
    (model) => model.providerID === ref.providerID && model.id === ref.id,
  )
  if (!selected) return undefined
  const provider = yield* catalog.provider.get(selected.providerID)
  const connection = yield* integrations.connection.active(
    provider?.integrationID ?? Integration.ID.make(selected.providerID),
  )
  const envKey = connection?.type === "env" ? process.env[connection.name] : undefined
  const credential =
    connection?.type === "credential"
      ? (yield* credentials.get(connection.id))?.value
      : envKey === undefined
        ? undefined
        : Credential.Key.make({ type: "key", key: envKey })
  const agent = yield* agents.resolve()
  const model = yield* SessionRunnerModel.resolve({ model: ref }, selected, credential, agent).pipe(Effect.option)
  if (Option.isNone(model)) return undefined
  return yield* binding(ref, model.value)
})

export function verified(db: Database.Interface["db"], directory: string, binding: string) {
  return db
    .select({ binding: MemoryTidyCountTable.binding })
    .from(MemoryTidyCountTable)
    .where(and(eq(MemoryTidyCountTable.directory, directory), eq(MemoryTidyCountTable.binding, binding)))
    .get()
    .pipe(Effect.map(Boolean))
}

export function remember(db: Database.Interface["db"], directory: string, binding: string, verified: boolean) {
  return verified
    ? db.insert(MemoryTidyCountTable).values({ directory, binding }).onConflictDoNothing().run()
    : db
        .delete(MemoryTidyCountTable)
        .where(and(eq(MemoryTidyCountTable.directory, directory), eq(MemoryTidyCountTable.binding, binding)))
        .run()
}

export function automaticBinding(db: Database.Interface["db"], runID: string) {
  return db
    .select({ binding: MemoryAutomaticTable.count_binding })
    .from(MemoryAutomaticRunTable)
    .leftJoin(
      MemoryAutomaticTable,
      and(
        eq(MemoryAutomaticTable.directory, MemoryAutomaticRunTable.directory),
        eq(MemoryAutomaticTable.generation, MemoryAutomaticRunTable.generation),
      ),
    )
    .where(eq(MemoryAutomaticRunTable.run_id, runID))
    .get()
}
