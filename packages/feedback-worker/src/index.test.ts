import { afterAll, beforeAll, expect, test } from "bun:test"
import { execFile, spawn } from "node:child_process"
import { createServer } from "node:http"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
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
const portProbe = createServer()
await new Promise<void>((done) => portProbe.listen(0, "127.0.0.1", done))
const portAddress = portProbe.address()
if (!portAddress || typeof portAddress === "string") throw new Error("Missing local Worker port")
const port = portAddress.port
await new Promise<void>((done, reject) => portProbe.close((error) => (error ? reject(error) : done())))
const base = "http://127.0.0.1:" + port
await mkdir(root, { recursive: true })
await mkdir(root + "/profile", { recursive: true })
await mkdir(root + "/temp", { recursive: true })
const child = spawn(
  "node",
  [
    resolve("node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    root + "/state",
    "--var",
    "ACCESS_TEAM_DOMAIN:" + issuer,
    "--var",
    "ACCESS_AUD:local-fixture",
  ],
  {
    env: {
      ACCESS_TEAM_DOMAIN: "https://company-console-58d97556.cloudflareaccess.com",
      ACCESS_AUD: "cc9a377b9898db5561a1365d623f78074b7928e9ca74e8d6a6dca0e30cc30a25",
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.COMSPEC,
      HOME: root + "/profile",
      USERPROFILE: root + "/profile",
      APPDATA: root + "/profile",
      LOCALAPPDATA: root + "/profile",
      XDG_CONFIG_HOME: root + "/profile",
      TEMP: root + "/temp",
      TMP: root + "/temp",
      WRANGLER_LOG_PATH: root + "/wrangler.log",
      WRANGLER_SEND_METRICS: "false",
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  },
)
const logWrites: Promise<void>[] = []
child.stdout.on("data", (data) => logWrites.push(appendFile(root + "/runtime.log", data)))
child.stderr.on("data", (data) => logWrites.push(appendFile(root + "/runtime.log", data)))
const stopped = new Promise<number | null>((done) => child.once("close", done))
async function ownedBirth() {
  if (!child.pid) throw new Error("Missing owned Worker pid")
  if (process.platform !== "win32")
    return (await readFile("/proc/" + child.pid + "/stat", "utf8"))
      .split(") ")
      .slice(1)
      .join(") ")
      .trim()
      .split(/\s+/)[19]
  return new Promise<string>((done, reject) =>
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$p = Get-CimInstance Win32_Process -Filter 'ProcessId = " +
          child.pid +
          "'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }",
      ],
      { windowsHide: true },
      (error, value) => (error ? reject(error) : done(value.trim())),
    ),
  )
}
let birth: string | undefined
beforeAll(async () => {
  birth = await ownedBirth()
  if (!birth) throw new Error("Missing owned process birth")
  await writeFile(root + "/runtime-process.json", JSON.stringify({ pid: child.pid, birth }))
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(base + "/health").then(
        (response) => response.ok,
        () => false,
      )
    )
      return
    if (child.exitCode !== null) throw new Error("Worker failed to start; inspect runtime.log")
    await Bun.sleep(200)
  }
  throw new Error("Local Worker readiness timeout")
}, 30_000)
afterAll(async () => {
  if (child.exitCode === null && child.pid)
    await new Promise<void>((done, reject) =>
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) =>
        error ? reject(error) : done(),
      ),
    )
  await stopped
  await Promise.all(logWrites)
  await new Promise<void>((done, reject) => jwks.close((error) => (error ? reject(error) : done())))
})

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
