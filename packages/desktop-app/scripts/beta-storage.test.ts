import { expect, test } from "bun:test"
import { S3Client, YAML } from "bun"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { planBeta } from "./beta-release"
import { continuousIdentity, deliverBeta, nextBetaVersion, reserveBetaVersion } from "./beta-storage"

const root = process.env.ZAOVRA_BETA_TEST_DIR
if (!root) throw new Error("Use an isolated ZAOVRA_BETA_TEST_DIR")
const sha = "a".repeat(40)
const identity = { commit: sha, run: "123", attempt: "1" }

async function fixture() {
  const directory = join(root!, crypto.randomUUID())
  await mkdir(directory, { recursive: true })
  const installer = "synthetic compiler output, never executed"
  const hash = createHash("sha512").update(installer).digest("base64")
  await Bun.write(join(directory, "zaovra-desktop-win-x64.exe"), installer)
  await Bun.write(join(directory, "zaovra-desktop-win-x64.exe.blockmap"), "blockmap")
  await Bun.write(
    join(directory, "beta.yml"),
    YAML.stringify({
      version: "0.1.1-beta.4",
      path: "zaovra-desktop-win-x64.exe",
      sha512: hash,
      files: [{ url: "zaovra-desktop-win-x64.exe", size: Buffer.byteLength(installer), sha512: hash }],
    }),
  )
  const plan = await planBeta(directory, sha, "reviewed synthetic release")
  const old = YAML.stringify({ version: "0.1.1-beta.3", path: "0.1.1-beta.3/zaovra-desktop-win-x64.exe" })
  const objects = new Map<string, string>([
    ["beta/beta.yml", old],
    ["beta/reservations/0.1.1-beta.4.json", JSON.stringify({ version: plan.manifest.version, ...identity })],
  ])
  const writes: string[] = []
  const control = { publicArtifactBad: false, publicPointerBad: false, compete: false }
  const etag = (body: string) => '"' + createHash("md5").update(body).digest("hex") + '"'
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.searchParams.get("list-type") === "2")
        return new Response(
          '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>' +
            [...objects.keys()].map((key) => "<Contents><Key>" + key + "</Key><Size>1</Size></Contents>").join("") +
            "</ListBucketResult>",
          { headers: { "content-type": "application/xml" } },
        )
      const isPublic = url.pathname.startsWith("/public/")
      const key = url.pathname.replace(/^\/(?:public\/|zaovra-updates\/)?/, "")
      if (request.method === "GET") {
        if (!objects.has(key)) return new Response("missing", { status: 404 })
        if (
          isPublic &&
          ((key.endsWith(".exe") && control.publicArtifactBad) || (key === "beta/beta.yml" && control.publicPointerBad))
        )
          return new Response("tampered cache")
        return new Response(objects.get(key), { headers: { etag: etag(objects.get(key)!) } })
      }
      if (request.method !== "PUT") return new Response("method", { status: 405 })
      if (key === "beta/beta.yml" && control.compete) {
        objects.set(key, YAML.stringify({ version: "0.1.1-beta.99" }))
        control.compete = false
      }
      const existing = objects.get(key)
      if (
        (request.headers.get("if-none-match") === "*" && existing !== undefined) ||
        (request.headers.has("if-match") &&
          (existing === undefined || request.headers.get("if-match") !== etag(existing)))
      )
        return new Response("precondition", { status: 412 })
      const body = await request.text()
      objects.set(key, body)
      writes.push(key)
      return new Response(null, { headers: { etag: etag(body) } })
    },
  })
  const bucket = new S3Client({
    bucket: "zaovra-updates",
    endpoint: server.url.origin,
    region: "auto",
    accessKeyId: "synthetic",
    secretAccessKey: "synthetic",
  })
  return { directory, plan, old, objects, writes, control, server, bucket }
}

test("646 counter includes reservations and immutable directories, rejects overflow and newer base", () => {
  expect(
    nextBetaVersion(
      ["beta/0.1.0-beta.99/release.json", "beta/0.1.1-beta.9/installer.exe", "beta/reservations/0.1.1-beta.11.json"],
      "0.1.1-beta.10",
    ),
  ).toBe("0.1.1-beta.12")
  expect(nextBetaVersion([], "0.1.1-beta.3")).toBe("0.1.1-beta.4")
  expect(() => nextBetaVersion([], "0.1.2-beta.1")).toThrow()
  expect(() => nextBetaVersion([], "0.1.1-beta.65535")).toThrow()
  expect(() => nextBetaVersion([], "prod")).toThrow()
})

test("646 continuous permission requires trusted exact workflow identity", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    EVENT_NAME: "workflow_run",
    GITHUB_REPOSITORY: "zuozizuozi/p-zaovra",
    BETA_SOURCE_SHA: sha,
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  }
  expect(continuousIdentity(env)).toEqual(identity)
  for (const key of Object.keys(env)) expect(() => continuousIdentity({ ...env, [key]: "wrong" })).toThrow()
})

test("646 concurrent HTTP reservations allocate distinct never-reused versions", async () => {
  const f = await fixture()
  try {
    const versions = await Promise.all([
      reserveBetaVersion(f.bucket, identity),
      reserveBetaVersion(f.bucket, { ...identity, attempt: "2" }),
    ])
    expect(new Set(versions).size).toBe(2)
    expect(versions.toSorted()).toEqual(["0.1.1-beta.5", "0.1.1-beta.6"])
  } finally {
    await f.server.stop(true)
  }
})

test("646 public hashes precede pointer and both immutable files survive", async () => {
  const f = await fixture()
  try {
    await deliverBeta(f.bucket, f.directory, f.plan, f.server.url.origin + "/public/", identity)
    expect(f.objects.get("beta/beta.yml")).toBe(f.plan.metadata)
    expect(f.writes.at(-1)).toBe("beta/beta.yml")
    expect(f.objects.has(f.plan.prefix + "zaovra-desktop-win-x64.exe")).toBe(true)
    expect(f.objects.has(f.plan.prefix + "zaovra-desktop-win-x64.exe.blockmap")).toBe(true)
    await expect(
      deliverBeta(f.bucket, f.directory, f.plan, f.server.url.origin + "/public/", identity),
    ).rejects.toThrow("increase")
  } finally {
    await f.server.stop(true)
  }
})

test("646 public artifact corruption never changes old pointer", async () => {
  const f = await fixture()
  try {
    f.control.publicArtifactBad = true
    await expect(
      deliverBeta(f.bucket, f.directory, f.plan, f.server.url.origin + "/public/", identity),
    ).rejects.toThrow("Public Beta artifact hash")
    expect(f.objects.get("beta/beta.yml")).toBe(f.old)
    expect(f.writes).not.toContain("beta/beta.yml")
  } finally {
    await f.server.stop(true)
  }
})

test("646 pointer public failure restores old release by conditional write", async () => {
  const f = await fixture()
  try {
    f.control.publicPointerBad = true
    await expect(
      deliverBeta(f.bucket, f.directory, f.plan, f.server.url.origin + "/public/", identity),
    ).rejects.toThrow("previous release restored")
    expect(f.objects.get("beta/beta.yml")).toBe(f.old)
  } finally {
    await f.server.stop(true)
  }
})

test("646 competing publish and reservation-owner mismatch fail closed", async () => {
  const f = await fixture()
  try {
    await expect(
      deliverBeta(f.bucket, f.directory, f.plan, f.server.url.origin + "/public/", { ...identity, attempt: "2" }),
    ).rejects.toThrow("owner mismatch")
    expect(f.writes).toHaveLength(0)
    f.control.compete = true
    await expect(
      deliverBeta(f.bucket, f.directory, f.plan, f.server.url.origin + "/public/", identity),
    ).rejects.toThrow("pointer changed")
    expect(YAML.parse(f.objects.get("beta/beta.yml")!).version).toBe("0.1.1-beta.99")
  } finally {
    await f.server.stop(true)
  }
})
