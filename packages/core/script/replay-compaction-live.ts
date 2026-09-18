// Four approved summary-only replays. Never executes returned tools or retries requests.
import { createHash } from "node:crypto"
import path from "node:path"
import { SessionCompaction } from "../src/session/compaction"

const preparedRoot = process.argv[2]
const connectionFile = process.argv[3]
if (!preparedRoot || !connectionFile) throw new Error("Expected prepared directory and connection file")
const prepared = await Bun.file(path.join(preparedRoot, "prepared.json")).json()
const sourceHash = createHash("sha256")
  .update(await Bun.file(new URL("../src/session/compaction.ts", import.meta.url)).text())
  .digest("hex")
if (sourceHash !== prepared.sourceSHA256 || prepared.cases.length !== 4)
  throw new Error("Prepared source or case count changed; review before calling provider")
const connection = await Bun.file(connectionFile).json()
const output = path.join(path.dirname(preparedRoot), `compaction-b2-live-${Date.now()}`)
const requests = await Promise.all(
  (prepared.cases as { id: string; original: string; originalSHA256: string }[]).map(async (row) => {
    const original = await Bun.file(row.original).text()
    const bytes = await Bun.file(path.join(preparedRoot, `${row.id}-request.json`)).text()
    const body = JSON.parse(bytes)
    if (
      createHash("sha256").update(original).digest("hex") !== row.originalSHA256 ||
      body.model !== connection.modelId ||
      body.messages.length !== 2 || body.messages[0].role !== "system" || body.messages[1].role !== "user" ||
      body.messages[1].content !== JSON.parse(original).messages[0].content ||
      body.max_tokens !== 4096 || body.tools?.length || body.stream !== true
    ) throw new Error(`Frozen request mismatch: ${row.id}`)
    return { id: row.id, bytes, sha256: createHash("sha256").update(bytes).digest("hex") }
  }),
)
await Bun.write(path.join(output, "registration.json"), JSON.stringify({
  preparedRoot, sourceHash, model: connection.modelId, referenceTokens: 200000,
  purpose: "Summary authority isolation only; not a full task replay or proof of read-only compliance",
  transport: "Node fetch; prior Bun connection failure retained separately with unknown usage, not a model result",
  policy: "One call per frozen case, no retries or tools. Finish active request; admit no further case after reference or unknown usage.",
  cases: requests.map(({ id, sha256 }) => ({ id, sha256 })),
}, null, 2))
console.log(JSON.stringify({ phase: "registered", output, cases: requests.length }))
const results: { id: string; tokens?: number; valid: boolean; error?: string }[] = []
for (const request of requests) {
  if (results.some((row) => row.tokens === undefined) || results.reduce((sum, row) => sum + (row.tokens ?? 0), 0) >= 200000) break
  await Bun.write(path.join(output, `${request.id}-request.json`), request.bytes)
  console.log(JSON.stringify({ phase: "request", id: request.id }))
  const started = Date.now()
  let raw = ""
  let text = ""
  let error: string | undefined
  let finish: string | undefined
  let usage: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined
  let toolEvents = 0
  let parseErrors = 0
  let status: number | undefined
  let done = false
  try {
    // The same endpoint is reachable with Node; Bun's connection failed before headers.
    // Pass credentials through stdin, never command arguments or diagnostic output.
    const child = Bun.spawn(["node", "--input-type=module", "-e", `
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      const config = JSON.parse(input);
      try {
        const response = await fetch(config.url, {
          method: 'POST', headers: {'Content-Type':'application/json', Authorization: 'Bearer ' + config.key},
          body: config.body,
        });
        process.stdout.write(JSON.stringify({status:response.status, raw:await response.text()}));
      } catch (error) {
        process.stdout.write(JSON.stringify({error:String(error).replaceAll(config.key, '[REDACTED]')}));
      }
    `], {
      stdin: new Blob([JSON.stringify({url: connection.baseUrl.replace(/\/$/, "") + "/chat/completions", key: connection.apiKey, body: request.bytes})]),
      stdout: "pipe", stderr: "pipe",
    })
    const encoded = await new Response(child.stdout).text()
    if (await child.exited !== 0) throw new Error("Node transport process failed")
    const response = JSON.parse(encoded)
    status = response.status
    raw = response.raw ?? ""
    error = response.error ?? (status === 200 ? undefined : `HTTP ${status}`)
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue
      if (line.slice(5).trim() === "[DONE]") { done = true; continue }
      let frame
      try { frame = JSON.parse(line.slice(5)) } catch { parseErrors++; continue }
      if (frame.error) error = "Provider returned an error frame"
      if (frame.usage) usage = frame.usage
      for (const choice of frame.choices ?? []) {
        if (choice.finish_reason) finish = choice.finish_reason
        text += choice.delta?.content ?? ""
        toolEvents += choice.delta?.tool_calls?.length ?? 0
        if (choice.delta?.function_call) toolEvents++
      }
    }
  } catch (cause) { error = String(cause).replaceAll(connection.apiKey, "[REDACTED]") }
  const invalid = SessionCompaction.invalidSummary(text)
  const row = { id: request.id, status, finish, done, usage, tokens: usage?.total_tokens, toolEvents, parseErrors,
    invalid, error, elapsedMs: Date.now() - started,
    valid: !error && finish === "stop" && done && !toolEvents && !parseErrors && !invalid,
  }
  await Bun.write(path.join(output, `${request.id}-response.sse`), raw.replaceAll(connection.apiKey, "[REDACTED]"))
  await Bun.write(path.join(output, `${request.id}-summary.md`), text.replaceAll(connection.apiKey, "[REDACTED]"))
  results.push(row)
  await Bun.write(path.join(output, "results.json"), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ phase: "result", ...row }))
}
console.log(JSON.stringify({ phase: "complete", output, calls: results.length,
  tokens: results.reduce((sum, row) => sum + (row.tokens ?? 0), 0), unknown: results.filter((row) => row.tokens === undefined).length,
  sourceUnchanged: sourceHash === createHash("sha256").update(await Bun.file(new URL("../src/session/compaction.ts", import.meta.url)).text()).digest("hex"),
}))
