import { isIP } from "node:net"
import { Context, Effect } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ServerAuth } from "../auth"
import { CorsConfig, isAllowedCorsOrigin } from "../cors"
import type { CorsOptions } from "../cors"

export const RequestAuthority = Context.Reference<{ readonly hostname?: string }>("@zaovra/RequestAuthority", {
  defaultValue: () => ({}),
})

export function isAllowedUnprotectedRequest(input: {
  authority: string | undefined
  origin: string | undefined
  hostname?: string
  cors?: CorsOptions["cors"]
}) {
  // Forwarded headers are never authority. A proxy must preserve the configured
  // Host and enforce its own access policy, or use server authentication.
  if (!input.authority || /[\s\\/@?#,%]/.test(input.authority)) return false
  if (!URL.canParse(`http://${input.authority}`)) return false
  const target = new URL(`http://${input.authority}`)
  if (target.port === "0") return false
  const host = target.hostname.toLowerCase().replace(/\.$/, "")
  const configured = input.hostname
    ?.toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  const address = host.replace(/^\[|\]$/g, "")
  const local = host === "localhost" || address === "127.0.0.1" || address === "::1"
  const embedded = input.origin === undefined && (host === "zaovra.internal" || host === "zaovra.local")
  if (!local && !isIP(address) && configured !== address && !embedded) return false
  if (input.origin === undefined) return true
  if (!URL.canParse(input.origin)) return false
  const origin = new URL(input.origin)
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.pathname !== "/" && origin.pathname !== "")
  )
    return false
  if ((origin.protocol === "http:" || origin.protocol === "https:") && origin.host === target.host) return true
  return isAllowedCorsOrigin(input.origin, { cors: input.cors })
}

export const requestOriginLayer = HttpRouter.middleware()(
  Effect.gen(function* () {
    const auth = yield* ServerAuth.Config
    const config = yield* RequestAuthority
    const cors = yield* CorsConfig
    const corsMiddleware = HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, cors),
      maxAge: 86_400,
    })
    return (effect) =>
      Effect.gen(function* () {
        if (ServerAuth.required(auth)) return yield* corsMiddleware(effect)
        const request = yield* HttpServerRequest.HttpServerRequest
        const absolute = URL.canParse(request.originalUrl) ? new URL(request.originalUrl) : undefined
        if (
          isAllowedUnprotectedRequest({
            authority: request.headers.host ?? absolute?.host,
            origin: request.headers.origin,
            hostname: config.hostname,
            cors: cors?.cors,
          })
        )
          return yield* corsMiddleware(effect)
        return HttpServerResponse.text("Untrusted Host or Origin", { status: 403 })
      })
  }),
  { global: true },
)
