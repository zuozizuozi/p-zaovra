import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { startEvaluationRelay } from "../../../script/evaluation/memory/relay"

const root = path.resolve(process.argv[2])
if (!root.startsWith(path.resolve("F:/Zaovra-研发记录/逐次记录") + path.sep))
  throw new Error("isolated-output-required")
const name = process.argv[3]
const manifestPath = path.resolve(process.argv[4])
if (!manifestPath.startsWith(path.resolve("F:/Zaovra-研发记录/逐次记录") + path.sep))
  throw new Error("isolated-manifest-required")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
if (!/^[a-f0-9]{40}$/.test(manifest.sourceSHA) || manifest.version !== "0.2.4-beta.1")
  throw new Error("candidate-identity-required")
if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error("fresh-fixture-name-required")
const source = path.resolve(import.meta.dir, "../../..")
const output = path.join(root, name)
if (existsSync(output)) throw new Error("fresh-fixture-output-required")
const executable = path.join(source, "packages/desktop-app/dist/win-unpacked/Zaovra Beta.exe")
const asarSHA256 = createHash("sha256")
  .update(readFileSync(path.join(source, "packages/desktop-app/dist/win-unpacked/resources/app.asar")))
  .digest("hex")
if (
  asarSHA256 !==
  manifest.files.find((file: { path: string }) =>
    file.path.replaceAll("\\", "/").endsWith("/win-unpacked/resources/app.asar"),
  )?.sha256
)
  throw new Error("candidate-changed")
const observations: object[] = []
const timers = new Set<ReturnType<typeof setInterval>>()
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
      return new Response(null, { status: 404 })
    const body = (await request.json()) as {
      model: string
      messages: { role: string; content: string | { text?: string }[] }[]
    }
    const content = (message: (typeof body.messages)[number]) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? []).map((part) => part.text ?? "").join("")
    const pattern = /^(SHARED_SEED|SHARED_RATE_[123]|SHARED_RESUME_[123]|SHARED_AFTER_CLOSE)/
    const user = body.messages.findLastIndex((message) => message.role === "user" && pattern.test(content(message)))
    if (user < 0) throw new Error("fixture-prompt-mismatch")
    const marker = content(body.messages[user]).match(pattern)![0]
    const tools = body.messages.slice(user + 1).filter((message) => message.role === "tool")
    const cycle = marker.at(-1)
    if (marker.startsWith("SHARED_RATE_")) {
      const signal = path.join(output, `rate-${cycle}.json`)
      if (!existsSync(signal)) writeFileSync(signal, "http-429", { flag: "wx" })
      observations.push({ marker, action: "http-429", at: Date.now() })
      return Response.json(
        { error: { message: "fixture rate limit", type: "rate_limit_error", code: "rate_limit_exceeded" } },
        { status: 429, headers: { "retry-after": "60" } },
      )
    }
    const tool =
      marker === "SHARED_SEED" && tools.length === 0
        ? "write"
        : marker.startsWith("SHARED_RESUME_") && tools.length === 0
          ? "read"
          : marker.startsWith("SHARED_RESUME_") && tools.length === 1
            ? "write"
            : undefined
    const target = path.join(output, "temp/profile/documents/Zaovra 项目/shared-proof.txt")
    const args =
      tool === "write"
        ? {
            path: target,
            content: marker === "SHARED_SEED" ? "SHARED_0" : `SHARED_${cycle}`,
            ...(marker === "SHARED_SEED" ? {} : { expectedContent: `SHARED_${Number(cycle) - 1}` }),
          }
        : { path: target }
    observations.push({ marker, toolCount: tools.length, action: tool ?? "text", at: Date.now() })
    const chunk = (delta: object, finish_reason: string | null = null) =>
      "data: " +
      JSON.stringify({
        id: "multiwindow-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
        ...(finish_reason ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}),
      }) +
      "\n\n"
    if (marker.startsWith("SHARED_RESUME_") && !tool) {
      writeFileSync(path.join(output, `live-${cycle}.json`), "stream-open", { flag: "wx" })
      let timer: ReturnType<typeof setInterval>
      const clear = () => {
        clearInterval(timer)
        timers.delete(timer)
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(chunk({ role: "assistant", content: `SHARED_LIVE_${cycle}` })))
            timer = setInterval(() => {
              if (!existsSync(path.join(output, `release-${cycle}.json`))) return
              clear()
              controller.enqueue(encoder.encode(chunk({}, "stop") + "data: [DONE]\n\n"))
              controller.close()
            }, 100)
            timers.add(timer)
            request.signal.addEventListener("abort", clear, { once: true })
          },
          cancel() {
            clear()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    const text = marker === "SHARED_SEED" ? "SHARED_READY" : "SHARED_SURVIVED"
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_" + randomUUID(),
              type: "function",
              function: { name: tool, arguments: JSON.stringify(args) },
            },
          ],
        }
      : { role: "assistant", content: text }
    return new Response(chunk(delta) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const relay = startEvaluationRelay({
  baseURL: `http://127.0.0.1:${upstream.port}/v1`,
  apiKey: "fixture-only",
  model: "fixture",
  protocol: "openai-chat",
  journal: path.join(root, name + "-relay.jsonl"),
  maxRequests: 24,
  maxRequestBytes: 131072,
  maxOutput: 4096,
})
try {
  const binding = path.join(root, name + "-binding.json")
  writeFileSync(
    binding,
    JSON.stringify({
      output,
      executable,
      asarSHA256,
      sourceSHA: manifest.sourceSHA,
      version: manifest.version,
      auditComposer: process.argv[5] === "composer",
      model: "fixture",
      protocol: "openai-chat",
      kind: "scripted multiwindow validation; real API zero",
      baseURL: relay.baseURL,
      key: relay.apiKey,
    }),
    { flag: "wx" },
  )
  const child = Bun.spawn(["node", "e2e/candidate-multiwindow.mjs", binding], {
    cwd: path.join(source, "packages/desktop-app"),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })
  const exit = await child.exited
  const result = JSON.parse(readFileSync(path.join(output, "result.json"), "utf8"))
  if (exit !== 0 || !result.pass) throw new Error("multiwindow-fixture-failed")
  writeFileSync(path.join(root, name + "-assertions.json"), JSON.stringify({ exit, pass: true, realAPI: 0 }), {
    flag: "wx",
  })
} finally {
  await relay.stop()
  for (const timer of timers) clearInterval(timer)
  await upstream.stop(true)
  writeFileSync(path.join(root, name + "-upstream.json"), JSON.stringify(observations, null, 2), { flag: "wx" })
}
