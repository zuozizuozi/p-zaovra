import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { startEvaluationRelay } from "../../../script/evaluation/memory/relay"

const root = path.resolve(process.argv[2])
if (!root.startsWith(path.resolve("F:/Zaovra-研发记录/逐次记录") + path.sep))
  throw new Error("isolated-output-required")
const name = process.argv[3]
const direct = process.argv[4] === "direct"
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
    const user = body.messages.findLastIndex(
      (message) => message.role === "user" && content(message).startsWith("ARTIFACT_DELIVERY"),
    )
    if (user < 0) throw new Error("fixture-prompt-mismatch")
    const outputs = body.messages.slice(user + 1).filter((message) => message.role === "tool")
    const files = ["proof.pdf", "proof.png", "proof.svg"]
    const tool = direct
      ? outputs.length === 0
        ? "bash"
        : undefined
      : outputs.length < 2
        ? "bash"
        : outputs.length < 5
          ? "publish_artifact"
          : undefined
    const args =
      outputs.length === 0
        ? { command: "node generate.mjs", description: "Generate three artifact candidates" }
        : outputs.length === 1
          ? {
              command: "node check.mjs",
              description: "Check artifact candidate integrity",
              verification: "test",
              verification_targets: [
                ...files.map((file) => file + ".candidate"),
                "fixture.pdf",
                "generate.mjs",
                "check.mjs",
              ],
              verification_assertions: ["check.mjs"],
              verification_requirements: [
                "PDF bytes equal the known fixture, valid header and EOF",
                "PNG decodes to 64x48 expected pixels",
                "SVG contains intended text and dimensions",
              ],
            }
          : {
              candidate: files[outputs.length - 2] + ".candidate",
              path: files[outputs.length - 2],
              check: "call_artifact_1",
              expectedDigest: null,
            }
    observations.push({ step: outputs.length, action: tool ?? "text", outputs: outputs.map(content), at: Date.now() })
    const chunk = (delta: object, finish_reason: string | null = null) =>
      "data: " +
      JSON.stringify({
        id: "artifact-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
        ...(finish_reason ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}),
      }) +
      "\n\n"
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_artifact_" + outputs.length,
              type: "function",
              function: { name: tool, arguments: JSON.stringify(args) },
            },
          ],
        }
      : {
          role: "assistant",
          content:
            "ARTIFACT_DONE\n\n[PDF](proof.pdf)\n\n[PNG](proof.png)\n\n[SVG](proof.svg)\n\n" +
            (direct ? "脚本已生成文件，请预览。[旧参考](old.pdf)不是新成果。" : "完成文件完整性检查，视觉效果请预览。"),
        }
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
  maxRequests: 16,
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
      direct,
      sourceSHA: "b1c4f1e8f96127bec5cae427763e90574159bb6e",
      version: "0.2.4-beta.1",
      model: "fixture",
      protocol: "openai-chat",
      kind: "scripted artifacts validation; real API zero",
      baseURL: relay.baseURL,
      key: relay.apiKey,
      generator: path.join(import.meta.dir, "artifact-fixtures/generate.mjs"),
      checker: path.join(import.meta.dir, "artifact-fixtures/check.mjs"),
      pdf: path.join(source, "packages/app-ui/e2e/fixtures/artifact-scan.pdf"),
    }),
    { flag: "wx" },
  )
  const child = Bun.spawn(["node", "e2e/candidate-artifacts.mjs", binding], {
    cwd: path.join(source, "packages/desktop-app"),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })
  const exit = await child.exited
  const result = JSON.parse(readFileSync(path.join(output, "result.json"), "utf8"))
  if (exit !== 0 || !result.pass) throw new Error("artifact-fixture-failed")
  writeFileSync(path.join(root, name + "-assertions.json"), JSON.stringify({ exit, pass: true, realAPI: 0 }), {
    flag: "wx",
  })
} finally {
  await relay.stop()
  await upstream.stop(true)
  writeFileSync(path.join(root, name + "-upstream.json"), JSON.stringify(observations, null, 2), { flag: "wx" })
}
