import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { RequestExecutor } from "@zaovra-ai/llm/route"
import { LayerNodePlatform } from "@zaovra-ai/core/effect/app-node-platform"
import { StageUsageHeader } from "../../../../script/evaluation/memory/stage-usage"

const Config = Schema.UnknownFromJsonString.pipe(
  Schema.decodeTo(Schema.Struct({ baseURL: Schema.String, key: Schema.String })),
)

/** Add the isolated job's local stage grant at the executor, leaving the frozen model projection untouched. */
export function stageUsageExecutor(value: string) {
  const options = Schema.decodeUnknownSync(Config)(value)
  const endpoint = new URL(options.baseURL)
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.pathname !== "/v1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^[a-f0-9-]{36}$/.test(options.key)
  )
    throw new Error("invalid-evaluation-stage-usage-host")
  const targets = [endpoint.href + "/responses", endpoint.href + "/chat/completions"]
  // Attach the grant below the Effect request trace. It is only sent to the owned loopback relay.
  const send = Object.assign(
    (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (!(url instanceof URL) || init?.method !== "POST" || !targets.includes(url.href)) return fetch(url, init)
      const headers = new Headers(init.headers)
      headers.set(StageUsageHeader, options.key)
      return fetch(url, { ...init, headers, redirect: "error" })
    },
    { preconnect: fetch.preconnect },
  )
  const http = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, HttpClient.transformResponse(Effect.provideService(FetchHttpClient.Fetch, send))),
  ).pipe(Layer.provide(FetchHttpClient.layer))
  return [LayerNodePlatform.requestExecutor, RequestExecutor.layer.pipe(Layer.provide(http))] as const
}
