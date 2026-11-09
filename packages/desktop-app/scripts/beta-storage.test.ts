import { expect, test } from "bun:test"
import { S3Client, YAML } from "bun"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { planBeta } from "./beta-release"
import {
  continuousIdentity,
  deliverBeta,
  nextBetaVersion,
  requireBetaVersion,
  reserveBetaVersion,
  retainBetaVersions,
} from "./beta-storage"

const root = process.env.ZAOVRA_BETA_TEST_DIR
if (!root) throw new Error("Use an isolated ZAOVRA_BETA_TEST_DIR")
const sha = "a".repeat(40)
const identity = { commit: sha, run: "123", attempt: "1" }

async function fixture(version = "0.1.1-beta.4", previous = "0.1.1-beta.3") {
  const directory = join(root!, crypto.randomUUID())
  await mkdir(directory, { recursive: true })
  const installer = "synthetic compiler output, never executed"
  const hash = createHash("sha512").update(installer).digest("base64")
  await Bun.write(join(directory, "zaovra-desktop-win-x64.exe"), installer)
  await Bun.write(join(directory, "zaovra-desktop-win-x64.exe.blockmap"), "blockmap")
  await Bun.write(
    join(directory, "beta.yml"),
    YAML.stringify({
      version,
      path: "zaovra-desktop-win-x64.exe",
      sha512: hash,
      files: [{ url: "zaovra-desktop-win-x64.exe", size: Buffer.byteLength(installer), sha512: hash }],
    }),
  )
  const plan = await planBeta(directory, sha, "reviewed synthetic release")
  const old = YAML.stringify({ version: previous, path: previous + "/zaovra-desktop-win-x64.exe" })
  const objects = new Map<string, string>([
    ["beta/beta.yml", old],
    ["beta/reservations/" + version + ".json", JSON.stringify({ version: plan.manifest.version, ...identity })],
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
      if (request.method === "GET" || request.method === "HEAD") {
        if (!objects.has(key)) return new Response("missing", { status: 404 })
        if (
          isPublic &&
          ((key.endsWith(".exe") && control.publicArtifactBad) || (key === "beta/beta.yml" && control.publicPointerBad))
        )
          return new Response("tampered cache")
        return new Response(objects.get(key), {
          headers: { etag: etag(objects.get(key)!), "content-length": String(Buffer.byteLength(objects.get(key)!)) },
        })
      }
      if (request.method === "DELETE") {
        objects.delete(key)
        writes.push("DELETE:" + key)
        return new Response(null, { status: 204 })
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

test("780 visible patch sequence includes reservations and immutable directories, preserves legacy inventory", () => {
  expect(
    nextBetaVersion(
      ["beta/0.1.0-beta.99/release.json", "beta/0.1.1-beta.9/installer.exe", "beta/reservations/0.1.1-beta.11.json"],
      "0.1.1-beta.10",
    ),
  ).toBe("0.2.0-beta.1")
  expect(nextBetaVersion([], "0.1.1-beta.19")).toBe("0.2.0-beta.1")
  expect(nextBetaVersion(["beta/reservations/0.2.0-beta.1.json"], "0.1.1-beta.19")).toBe("0.2.1-beta.1")
  expect(nextBetaVersion(["beta/0.2.1-beta.1/release.json"], "0.2.0-beta.1")).toBe("0.2.2-beta.1")
  expect(() => nextBetaVersion([], "0.3.0-beta.1")).toThrow()
  expect(() => nextBetaVersion([], "0.2.65535-beta.1")).toThrow()
  expect(() => nextBetaVersion([], "0.2.0-beta.2")).toThrow()
  expect(() => nextBetaVersion([], "prod")).toThrow()
})

test("780 manual builds require an explicit canonical reviewed version", () => {
  expect(requireBetaVersion("0.2.0-beta.1")).toBe("0.2.0-beta.1")
  for (const version of [undefined, "0.1.1-beta.20", "0.2.01-beta.1", "0.2.0-beta.2", "0.2.65536-beta.1", "prod"])
    expect(() => requireBetaVersion(version)).toThrow()
})

test("780 manual CLI writes only the reviewed version to workflow output without storage credentials", async () => {
  const output = join(root!, "manual780-" + crypto.randomUUID())
  const command = async (version: string) => {
    const child = Bun.spawn([process.execPath, "scripts/beta-storage.ts", "manual"], {
      env: {
        ...process.env,
        BETA_VERSION: version,
        GITHUB_ENV: output,
        R2_ACCESS_KEY_ID: "",
        R2_SECRET_ACCESS_KEY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { out, error, code }
  }
  const selected = await command("0.2.0-beta.1")
  expect(selected.code).toBe(0)
  expect(selected.out).toContain("Selected reviewed 0.2.0-beta.1")
  expect(await Bun.file(output).text()).toBe("ZAOVRA_VERSION=0.2.0-beta.1\n")
  expect((await command("0.1.1-beta.20")).code).toBe(1)
  expect(await Bun.file(output).text()).toBe("ZAOVRA_VERSION=0.2.0-beta.1\n")
})

test("780 Beta.19 pointer upgrades through the existing immutable delivery and rollback contract", async () => {
  const f = await fixture("0.2.0-beta.1", "0.1.1-beta.19")
  try {
    await deliverBeta(f.bucket, f.directory, f.plan, f.server.url.origin + "/public/", identity)
    const published = YAML.parse(f.objects.get("beta/beta.yml")!)
    expect(published.version).toBe("0.2.0-beta.1")
    expect(published.path).toBe("0.2.0-beta.1/zaovra-desktop-win-x64.exe")
    expect(f.writes.at(-1)).toBe("beta/beta.yml")
    await expect(
      deliverBeta(f.bucket, f.directory, f.plan, f.server.url.origin + "/public/", identity),
    ).rejects.toThrow("increase")
  } finally {
    await f.server.stop(true)
  }
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
    expect(versions.toSorted()).toEqual(["0.2.0-beta.1", "0.2.1-beta.1"])
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

test("646 retention keeps five only after verified pointer ownership and rejects foreign paths", async () => {
  const f = await fixture()
  try {
    const current = "0.1.1-beta.7"
    const versions = [1, 2, 3, 4, 5, 6].map((number) => "0.1.1-beta." + number)
    f.objects.set("beta/versions.json", JSON.stringify(versions))
    f.objects.set("beta/beta.yml", YAML.stringify({ version: current }))
    const files = ["zaovra-desktop-win-x64.exe", "zaovra-desktop-win-x64.exe.blockmap"].map((name) => ({ name }))
    for (const version of versions)
      f.objects.set("beta/" + version + "/release.json", JSON.stringify({ version, files }))
    f.objects.set(
      "beta/0.1.1-beta.1/release.json",
      JSON.stringify({ version: "0.1.1-beta.1", files: [{ name: "../private" }] }),
    )
    await expect(retainBetaVersions(f.bucket, current)).rejects.toThrow("outside the owned")
    expect(f.writes).toHaveLength(0)
    f.objects.set("beta/0.1.1-beta.1/release.json", JSON.stringify({ version: "0.1.1-beta.1", files }))
    const result = await retainBetaVersions(f.bucket, current)
    expect(result.retired).toEqual(["0.1.1-beta.2", "0.1.1-beta.1"])
    expect(result.retained).toHaveLength(5)
    expect(f.objects.has("beta/0.1.1-beta.3/release.json")).toBe(true)
    expect(f.objects.has("beta/reservations/0.1.1-beta.4.json")).toBe(true)
    f.objects.set("beta/beta.yml", YAML.stringify({ version: "0.1.1-beta.8" }))
    await expect(retainBetaVersions(f.bucket, current)).rejects.toThrow("newer publisher")
  } finally {
    await f.server.stop(true)
  }
})
