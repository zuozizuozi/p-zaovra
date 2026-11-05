import { archiveFeedback } from "../scripts/archive-feedback"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { Feedback } from "../../schema/src/feedback"
import { safeSnapshot } from "./index"

const root = process.env.ZAOVRA_WORKER_TEST_DIR
if (!root) throw new Error("Set ZAOVRA_WORKER_TEST_DIR to the current F: record directory")
const keys = await generateKeyPair("RS256")
const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "local-fixture", alg: "RS256", use: "sig" }
const jwks = createServer((_request, response) => {
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify({ keys: [publicKey] }))
})
await new Promise<void>((done) => jwks.listen(0, "127.0.0.1", done))
const address = jwks.address()
if (!address || typeof address === "string") throw new Error("Missing local JWKS port")
const issuer = "http://127.0.0.1:" + address.port
let base = ""
const logWrites: Promise<void>[] = []
await mkdir(root, { recursive: true })
const child = spawn("node", ["scripts/worker-fixture.mjs", issuer], {
  env: {
    ACCESS_TEAM_DOMAIN: "https://company-console-58d97556.cloudflareaccess.com",
    ACCESS_AUD: "cc9a377b9898db5561a1365d623f78074b7928e9ca74e8d6a6dca0e30cc30a25",
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        [
          "PATH",
          "SystemRoot",
          "WINDIR",
          "COMSPEC",
          "HOME",
          "USERPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_CACHE_HOME",
          "TEMP",
          "TMP",
          "WRANGLER_LOG_PATH",
          "WRANGLER_SEND_METRICS",
          "ZAOVRA_WORKER_TEST_DIR",
        ].includes(key),
      ),
    ),
  },
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
})
child.stdout.on("data", (data) => logWrites.push(appendFile(root + "/runtime.log", data)))
child.stderr.on("data", (data) => logWrites.push(appendFile(root + "/runtime.log", data)))
const stopped = new Promise<number | null>((done) => child.once("close", done))
const startupTimeout = 90_000
beforeAll(async () => {
  const started = performance.now()
  // Cold Windows runners may still be starting Miniflare after the former 20-second window.
  while (performance.now() - started < startupTimeout) {
    if (await Bun.file(root + "/runtime-ready.json").exists()) {
      const ready = JSON.parse(await readFile(root + "/runtime-ready.json", "utf8")) as {
        base: string
        pid: number
        birth: string
      }
      if (ready.pid !== child.pid || !ready.birth) throw new Error("Fixture identity mismatch")
      base = ready.base
      console.info("Local Worker fixture ready after " + Math.round(performance.now() - started) + "ms")
      return
    }
    if (child.exitCode !== null) throw new Error("Local Worker fixture failed; inspect runtime.log")
    await Bun.sleep(200)
  }
  const phase = Bun.file(root + "/runtime-phase.json")
  throw new Error(
    "Local Worker fixture readiness timed out after " +
      startupTimeout +
      "ms; phase=" +
      ((await phase.exists()) ? await phase.text() : "unavailable"),
  )
}, startupTimeout + 30_000)
afterAll(async () => {
  child.stdin.end()
  const exit = await stopped
  await Promise.all(logWrites)
  await new Promise<void>((done, reject) => jwks.close((error) => (error ? reject(error) : done())))
  await writeFile(
    root + "/runtime-cleanup.json",
    JSON.stringify({
      fixture_exit: exit,
      managed_worker_stop: await Bun.file(root + "/runtime-stopped.json").exists(),
      JWKS_closed: true,
      manual_PID_signals: 0,
    }),
  )
  console.info("Local Worker fixture stopped with exit " + exit)
  expect(exit).toBe(0)
}, 30_000)

function snapshot() {
  return Feedback.snapshot({
    description: "A test report",
    now: Date.now(),
    context: { version: "0.1.0-beta.550", platform: "windows", model: "gpt-6-luna" },
    include: { environment: true, events: true, errors: true },
  })
}
function submit(value: unknown) {
  return fetch(base + "/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  })
}
async function token(audience = "local-fixture", expiration = "2m") {
  return new SignJWT({ email: "fixture@example.invalid" })
    .setProtectedHeader({ alg: "RS256", kid: "local-fixture" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(keys.privateKey)
}

test("default payload excludes conversation and server sanitizes credential fields", () => {
  const value = snapshot()
  expect(value.files.some((file) => file.name === "conversation.txt")).toBe(false)
  const report = { ...JSON.parse(value.text), password: "fixture-private-value", authorization: "Bearer fixture-value" }
  const text = JSON.stringify(report)
  const cleaned = safeSnapshot({ text, files: [{ name: "report.json", text }] })
  expect(cleaned.snapshot.text).not.toContain("fixture-private-value")
  expect(cleaned.snapshot.text).not.toContain("Bearer fixture-value")
  expect(() => safeSnapshot({ ...value, files: [{ name: "../../escape", text: "test" }] })).toThrow()
})

test("real local R2 persists reports, returns a stable receipt, and rejects conflicting retries", async () => {
  const value = snapshot()
  const first = await submit(value)
  expect(first.status).toBe(201)
  const receipt = safeSnapshot(value).receipt
  expect(JSON.stringify(await first.json())).toBe(JSON.stringify({ receipt, submitted: true }))
  expect((await submit(value)).status).toBe(200)
  const text = JSON.stringify({ ...JSON.parse(value.text), description: "changed" })
  expect((await submit({ text, files: [{ name: "report.json", text }] })).status).toBe(409)
  const response = await fetch(base + "/admin/report/" + receipt, {
    headers: { "cf-access-jwt-assertion": await token() },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ snapshot: { text: value.text } })
})

test("admin rejects missing, forged, wrong-audience and expired JWTs; authenticated list works", async () => {
  expect((await fetch(base + "/admin/reports")).status).toBe(403)
  for (const jwt of ["forged", await token("wrong-audience"), await token("local-fixture", "-1m")])
    expect((await fetch(base + "/admin/reports", { headers: { "cf-access-jwt-assertion": jwt } })).status).toBe(403)
  const response = await fetch(base + "/admin/reports", { headers: { "cf-access-jwt-assertion": await token() } })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ reports: expect.any(Array) })
})

test("invalid payloads and public report reads fail closed", async () => {
  expect((await submit({})).status).toBe(400)
  expect((await fetch(base + "/reports/example.json")).status).toBe(404)
})

test("Access service assertions authorize admin while raw Service Token headers cannot bypass JWT verification", async () => {
  expect(
    (
      await fetch(base + "/admin/reports", {
        headers: { "CF-Access-Client-Id": "fixture.access", "CF-Access-Client-Secret": "fixture-service-secret" },
      })
    ).status,
  ).toBe(403)
  const jwt = await new SignJWT({ common_name: "fixture.access", sub: "" })
    .setProtectedHeader({ alg: "RS256", kid: "local-fixture" })
    .setIssuer(issuer)
    .setAudience("local-fixture")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(keys.privateKey)
  expect((await fetch(base + "/admin/reports", { headers: { "cf-access-jwt-assertion": jwt } })).status).toBe(200)
})

test("stored feedback queues the native local email binding, and protected retry preserves the receipt", async () => {
  const value = snapshot()
  const receipt = safeSnapshot(value).receipt
  expect((await submit(value)).status).toBe(201)
  const headers = { "cf-access-jwt-assertion": await token() }
  let state: { status?: string } = {}
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(base + "/admin/notifications/" + receipt, { headers })
    if (response.ok) state = (await response.json()) as { status?: string }
    if (state.status === "sent" || state.status === "failed") break
    await Bun.sleep(50)
  }
  expect(state.status).toBe("sent")
  expect((await fetch(base + "/admin/notifications/" + receipt + "/retry", { method: "POST" })).status).toBe(403)
  expect((await fetch(base + "/admin/notifications/" + receipt + "/retry", { method: "POST", headers })).status).toBe(
    202,
  )
  expect((await fetch(base + "/admin/report/" + receipt, { headers })).status).toBe(200)
})

test("205 accepted expanded feedback persists and notifies through the actual local Worker and R2", async () => {
  const receipt = crypto.randomUUID()
  const text = JSON.stringify({ reportID: receipt, description: "集成扩展反馈", extra: Array(5000).fill(0) })
  expect(text.length).toBeLessThan(32_000)
  expect((await submit({ text, files: [{ name: "report.json", text }] })).status).toBe(201)
  const headers = { "cf-access-jwt-assertion": await token() }
  const stored = await fetch(base + "/admin/report/" + receipt, { headers })
  expect(stored.status).toBe(200)
  expect(((await stored.json()) as { snapshot: { text: string } }).snapshot.text.length).toBeGreaterThan(32_000)
  let status = ""
  for (let i = 0; i < 50; i++) {
    const response = await fetch(base + "/admin/notifications/" + receipt, { headers })
    if (response.ok) status = ((await response.json()) as { status: string }).status
    if (["sent", "failed", "invalid"].includes(status)) break
    await Bun.sleep(50)
  }
  expect(status).toBe("sent")
  const jwt = await token()
  const archived = await archiveFeedback({
    token: jwt,
    directory: root + "/expanded-archive",
    archiveRoot: root,
    fetcher: (url, init) =>
      fetch(base + new URL(url).pathname + new URL(url).search, {
        ...init,
        headers: { "cf-access-jwt-assertion": jwt },
      }),
  })
  expect(archived.map((entry) => entry.receipt)).toContain(receipt)
  expect(archived.find((entry) => entry.receipt === receipt)?.bytes).toBeGreaterThan(32_000)
})
