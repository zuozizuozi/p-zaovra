import { readFileSync, writeFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"

const root = path.resolve(process.argv[2])
if (!root.startsWith(path.resolve("F:/Zaovra-研发记录/逐次记录") + path.sep))
  throw new Error("isolated-output-required")
const name = process.argv[3]
if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error("fresh-fixture-name-required")
const source = path.resolve(import.meta.dir, "../../..")
const output = path.join(root, name)
const executable = path.join(source, "packages/desktop-app/dist/win-unpacked/Zaovra Beta.exe")
const asarSHA256 = createHash("sha256")
  .update(readFileSync(path.join(source, "packages/desktop-app/dist/win-unpacked/resources/app.asar")))
  .digest("hex")
if (asarSHA256 !== "3e4e80dd7ec7b6275864e260b3da7cf71cbeb1dcd6b68a2e2d86d3fb417b62ba")
  throw new Error("candidate-changed")
const observations: object[] = []
const receipts = path.join(root, name + "-receipts.json")
const image = path.resolve(process.argv[4])
if (!image.startsWith(path.resolve("F:/Zaovra-研发记录/逐次记录") + path.sep))
  throw new Error("fixture-image-path-required")
const digest = createHash("sha256").update(readFileSync(image)).digest("hex")
const key = randomUUID()
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  maxRequestBodySize: 131072,
  async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${key}`) return new Response(null, { status: 401 })
    if (request.method === "GET" && new URL(request.url).pathname === "/v1/models")
      return Response.json({ data: [{ id: "fixture", object: "model" }] })
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
      return new Response(null, { status: 404 })
    if (observations.length >= 12) return new Response(null, { status: 429 })
    const body = (await request.json()) as {
      model: string
      messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] }[]
    }
    if (body.model !== "fixture") return new Response(null, { status: 400 })
    const text = (message: (typeof body.messages)[number]) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? []).map((part) => part.text ?? "").join("")
    const user = body.messages.findLast((message) => message.role === "user" && /IMAGE_[A-Z_]+:/.test(text(message)))
    if (!user) throw new Error("fixture-marker-missing")
    const marker = text(user)
      .match(/IMAGE_[A-Z_]+:/)![0]
      .slice(0, -1)
    const images = (typeof user.content === "string" ? [] : user.content)
      .filter((part) => part.type === "image_url")
      .map((part) => {
        const url = part.image_url?.url ?? ""
        if (!url.startsWith("data:image/png;base64,")) throw new Error("unexpected-image-transport")
        const bytes = Buffer.from(url.split(",")[1], "base64")
        const sha256 = createHash("sha256").update(bytes).digest("hex")
        if (sha256 !== digest) throw new Error("only-fixed-fixture-image-allowed")
        return { bytes: bytes.length, sha256 }
      })
    observations.push({ marker, images, at: Date.now() })
    writeFileSync(receipts, JSON.stringify(observations, null, 2))
    const chunk = (delta: object, finish_reason: string | null = null) =>
      "data: " +
      JSON.stringify({
        id: "image-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
        ...(finish_reason ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}),
      }) +
      "\n\n"
    return new Response(
      chunk({ role: "assistant", content: marker + "_DONE" }) + chunk({}, "stop") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
try {
  const binding = path.join(root, name + "-binding.json")
  writeFileSync(
    binding,
    JSON.stringify({
      output,
      executable,
      asarSHA256,
      sourceSHA: "b1c4f1e8f96127bec5cae427763e90574159bb6e",
      version: "0.2.4-beta.1",
      model: "fixture",
      protocol: "openai-chat",
      baseURL: `http://127.0.0.1:${upstream.port}/v1`,
      key,
      image,
      receipts,
    }),
    { flag: "wx" },
  )
  const child = Bun.spawn(["node", "e2e/candidate-images.mjs", binding], {
    cwd: path.join(source, "packages/desktop-app"),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })
  const exit = await child.exited
  const result = JSON.parse(readFileSync(path.join(output, "result.json"), "utf8"))
  if (exit !== 0 || !result.pass) throw new Error("image-fixture-failed")
  writeFileSync(path.join(root, name + "-assertions.json"), JSON.stringify({ exit, pass: true, realAPI: 0 }), {
    flag: "wx",
  })
} finally {
  await upstream.stop(true)
  writeFileSync(path.join(root, name + "-upstream.json"), JSON.stringify(observations, null, 2), { flag: "wx" })
}
