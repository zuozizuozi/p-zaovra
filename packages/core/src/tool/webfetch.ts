export * as WebFetchTool from "./webfetch"

import { ToolFailure } from "@zaovra-ai/llm"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { Duration, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import TurndownService from "turndown"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { PermissionV2 } from "../permission"
import { collectBoundedResponseBody } from "./http-body"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "webfetch"
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
export const DEFAULT_TIMEOUT_SECONDS = 30
export const MAX_TIMEOUT_SECONDS = 120
export const MAX_REDIRECTS = 10

export const description = `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.

Use a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.`

const Timeout = Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS))

export const Input = Schema.Struct({
  url: Schema.String.annotate({ description: "The HTTP or HTTPS URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({ description: "The format to return the content in. Defaults to markdown." })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Timeout.pipe(Schema.optional).annotate({
    description: `Optional timeout in seconds (maximum: ${MAX_TIMEOUT_SECONDS})`,
  }),
})

const Output = Schema.Struct({
  url: Schema.String,
  contentType: Schema.String,
  format: Input.fields.format,
  output: Schema.String,
})

type Format = (typeof Input.Type)["format"]

const acceptHeader = (format: Format) => {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  }
  return "*/*"
}

const headers = (format: Format, userAgent: string) => ({
  "User-Agent": userAgent,
  Accept: acceptHeader(format),
  "Accept-Language": "en-US,en;q=0.9",
})

const browserUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

const isCloudflareChallenge = (error: unknown) => {
  if (!error || typeof error !== "object" || !("reason" in error)) return false
  const reason = error.reason
  if (
    !reason ||
    typeof reason !== "object" ||
    !("_tag" in reason) ||
    reason._tag !== "StatusCodeError" ||
    !("response" in reason)
  )
    return false
  const response = reason.response as HttpClientResponse.HttpClientResponse
  return response.status === 403 && response.headers["cf-mitigated"] === "challenge"
}

const request = (url: string, format: Format, userAgent = browserUserAgent) =>
  HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers(format, userAgent)))

const assertHttpUrl = (url: URL) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http:// or https://")
}

const resolveHost = (hostname: string) => lookup(hostname, { all: true, verbatim: true })
const metadataHosts = new Set([
  "metadata.google.internal",
  "metadata.google",
  "metadata.azure.internal",
  "metadata.aws.internal",
])

export async function validateNetworkTarget(url: URL, resolver = resolveHost) {
  assertHttpUrl(url)
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (hostname === "localhost" || hostname.endsWith(".localhost") || metadataHosts.has(hostname)) {
    throw new Error(`Local network target is not allowed: ${hostname}`)
  }
  const addresses = isIP(hostname) ? [hostname] : (await resolver(hostname)).map((result) => result.address)
  if (addresses.length === 0) throw new Error(`Host did not resolve: ${hostname}`)
  const blocked = addresses.find(isPrivateNetworkAddress)
  if (blocked) throw new Error(`Local network target is not allowed: ${blocked}`)
}

export function isPrivateNetworkAddress(input: string) {
  const address = input.split("%", 1)[0]?.replace(/^\[|\]$/g, "") ?? ""
  if (isIP(address) === 4) return isPrivateIPv4(address)
  if (isIP(address) !== 6) return true
  const words = ipv6Words(address)
  if (!words) return true
  if (words.every((word) => word === 0)) return true
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true
  if ((words[0]! & 0xfe00) === 0xfc00) return true
  if ((words[0]! & 0xffc0) === 0xfe80 || (words[0]! & 0xffc0) === 0xfec0) return true
  if ((words[0]! & 0xff00) === 0xff00) return true
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  const compatible = words.slice(0, 6).every((word) => word === 0)
  if (!mapped && !compatible) return false
  return isPrivateIPv4(
    [words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff].join("."),
  )
}

function isPrivateIPv4(address: string) {
  const bytes = address.split(".").map(Number)
  const [a, b] = bytes
  if (bytes.length !== 4 || bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b! >= 64 && b! <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b! >= 16 && b! <= 31) return true
  if (a === 192 && (b === 0 || b === 168)) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  return a! >= 224
}

function ipv6Words(address: string) {
  const dotted = address.slice(address.lastIndexOf(":") + 1)
  const normalized =
    isIP(dotted) === 4
      ? `${address.slice(0, address.lastIndexOf(":") + 1)}${dotted
          .split(".")
          .map(Number)
          .reduce((words, value, index) => {
            const word = Math.floor(index / 2)
            words[word] = ((words[word] ?? 0) << 8) | value
            return words
          }, [] as number[])
          .map((word) => word.toString(16))
          .join(":")}`
      : address
  const halves = normalized.split("::")
  if (halves.length > 2) return
  const left = halves[0] ? halves[0].split(":").map((word) => Number.parseInt(word, 16)) : []
  const right = halves[1] ? halves[1].split(":").map((word) => Number.parseInt(word, 16)) : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return
  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right]
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return
  return words
}

const execute = (http: HttpClient.HttpClient, url: string, format: Format, userAgent = browserUserAgent) => {
  const loop = (current: URL, redirects: number): Effect.Effect<HttpClientResponse.HttpClientResponse, unknown> =>
    Effect.tryPromise({
      try: () => validateNetworkTarget(current),
      catch: (error) => error,
    }).pipe(
      Effect.andThen(
        http
          .execute(request(current.toString(), format, userAgent))
          .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })),
      ),
      Effect.flatMap((response) => {
        if (response.status < 300 || response.status >= 400 || !response.headers.location) {
          return HttpClientResponse.filterStatusOk(response)
        }
        if (redirects >= MAX_REDIRECTS) return Effect.fail(new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`))
        return Effect.try({
          try: () => new URL(response.headers.location!, current),
          catch: (error) => error,
        }).pipe(Effect.flatMap((next) => loop(next, redirects + 1)))
      }),
    )
  return loop(new URL(url), 0)
}

const collectBody = (response: HttpClientResponse.HttpClientResponse) =>
  collectBoundedResponseBody(
    response,
    MAX_RESPONSE_BYTES,
    () => new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`),
  )

const mimeFrom = (contentType: string) => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
const isImageAttachment = (mime: string) =>
  mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
const isTextualMime = (mime: string) =>
  !mime ||
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime.endsWith("+json") ||
  mime === "application/xml" ||
  mime.endsWith("+xml") ||
  mime === "application/javascript" ||
  mime === "application/x-javascript"
const convert = (content: string, contentType: string, format: Format) => {
  if (!contentType.includes("text/html")) return content
  if (format === "markdown") return convertHTMLToMarkdown(content)
  if (format === "text") return extractTextFromHTML(content)
  return content
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const http = yield* HttpClient.HttpClient
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* Effect.tryPromise({
                try: () => validateNetworkTarget(new URL(input.url)),
                catch: (error) => error,
              })

              yield* permission.assert({
                action: name,
                resources: [input.url],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const { body, contentType } = yield* Effect.gen(function* () {
                const response = yield* execute(http, input.url, input.format).pipe(
                  Effect.catchIf(isCloudflareChallenge, () => execute(http, input.url, input.format, "zaovra")),
                )
                const contentType = response.headers["content-type"] || ""
                const mime = mimeFrom(contentType)
                if (isImageAttachment(mime))
                  return yield* Effect.fail(new Error(`Unsupported fetched image content type: ${mime}`))
                if (!isTextualMime(mime))
                  return yield* Effect.fail(new Error(`Unsupported fetched file content type: ${mime}`))
                return { body: yield* collectBody(response), contentType }
              }).pipe(
                Effect.timeoutOrElse({
                  duration: Duration.seconds(input.timeout ?? DEFAULT_TIMEOUT_SECONDS),
                  orElse: () => Effect.fail(new Error("Request timed out")),
                }),
              )
              const content = new TextDecoder().decode(body)
              const output = yield* Effect.try({
                try: () => convert(content, contentType, input.format),
                catch: (error) => error,
              })
              return {
                url: input.url,
                contentType,
                format: input.format,
                output,
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to fetch ${input.url}` }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/webfetch",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, LayerNodePlatform.httpClient],
})

export function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth++
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })
  parser.write(html)
  parser.end()
  return text.trim()
}

export function convertHTMLToMarkdown(html: string) {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndown.remove(["script", "style", "meta", "link"])
  return turndown.turndown(html)
}
