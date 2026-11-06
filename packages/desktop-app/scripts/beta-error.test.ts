import { expect, test } from "bun:test"
import { S3Client, YAML } from "bun"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { digest, planBeta } from "./beta-release"
import { deliverBeta, reserveBetaVersion } from "./beta-storage"

const root = process.env.ZAOVRA_BETA_TEST_DIR
if (!root) throw new Error("Use an isolated ZAOVRA_BETA_TEST_DIR")
const sha = "a".repeat(40)
const secret = "offline679-DO-NOT-LOG"

async function artifact() {
  const directory = join(root!, crypto.randomUUID())
  await mkdir(directory, { recursive: true })
  const installer = Bun.file(join(directory, "zaovra-desktop-win-x64.exe"))
  await Bun.write(installer, "synthetic bytes, never executed")
  const sha512 = await digest(installer)
  await Bun.write(join(directory, "zaovra-desktop-win-x64.exe.blockmap"), "synthetic blockmap")
  await Bun.write(
    join(directory, "beta.yml"),
    YAML.stringify({
      version: "0.1.1-beta.10",
      path: "zaovra-desktop-win-x64.exe",
      sha512,
      files: [{ url: "zaovra-desktop-win-x64.exe", size: installer.size, sha512 }],
    }),
  )
  return { directory, plan: await planBeta(directory, sha, "offline diagnostic") }
}

function bucket(endpoint: string) {
  return new S3Client({
    endpoint,
    bucket: "zaovra-updates",
    region: "auto",
    accessKeyId: secret,
    secretAccessKey: secret,
  })
}

test("679 CLI reports the failed plan operation without paths or credential text", async () => {
  const directory = join(root!, secret, crypto.randomUUID())
  await mkdir(directory, { recursive: true })
  const notes = join(directory, "notes.md")
  await Bun.write(notes, "offline")
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "beta-release.ts"), directory, sha, notes], {
    env: { HOME: root!, TEMP: root!, TMP: root! },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit).toBe(1)
  expect(stdout).toBe("")
  expect(stderr).not.toContain(secret)
  expect(stderr).toContain('"operation":"PlanBeta"')
  expect(stderr).toContain('"name":"Error"')
  expect(stderr).not.toContain("stack")
})

test("679 actual R2 HTTP failures preserve only status, S3 code and operation", async () => {
  const { betaErrorDetails } = await import("./beta-error")
  const value = await artifact()
  for (const code of ["AccessDenied", "NoSuchBucket", "SignatureDoesNotMatch"]) {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          "<Error><Code>" +
            code +
            "</Code><Message>" +
            secret +
            "</Message><Resource>https://user:" +
            secret +
            "@example.invalid/?X-Amz-Signature=" +
            secret +
            "</Resource></Error>",
          { status: 403, headers: { "content-type": "application/xml", "x-private": secret } },
        ),
    })
    try {
      const error = await deliverBeta(bucket(server.url.origin), value.directory, value.plan).then(
        () => {
          throw new Error("Unexpected success")
        },
        (error) => error,
      )
      expect(betaErrorDetails(error, "PublishBeta")).toEqual({ operation: "R2 GET", name: "Error", status: 403, code })
      expect(JSON.stringify(betaErrorDetails(error, "PublishBeta"))).not.toContain(secret)
    } finally {
      await server.stop(true)
    }
  }
})

test("679 native Bun S3 errors retain their code without raw error serialization", async () => {
  const { betaErrorDetails } = await import("./beta-error")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response("<Error><Code>AccessDenied</Code><Message>" + secret + "</Message></Error>", {
        status: 403,
        headers: { "content-type": "application/xml" },
      }),
  })
  try {
    const error = await reserveBetaVersion(bucket(server.url.origin), { commit: sha, run: "123", attempt: "1" }).then(
      () => {
        throw new Error("Unexpected success")
      },
      (error) => error,
    )
    const details = betaErrorDetails(error, "ReserveBeta")
    expect(details).toMatchObject({ operation: "R2 LIST", name: "S3Error", code: "AccessDenied" })
    expect(JSON.stringify(details)).not.toContain(secret)
  } finally {
    await server.stop(true)
  }
})

test("679 diagnostic fields reject credential-bearing names, codes and invalid statuses", async () => {
  const { betaErrorDetails } = await import("./beta-error")
  const error = Object.assign(new Error(secret), {
    name: secret,
    code: secret,
    statusCode: secret,
    url: secret,
    headers: secret,
    stack: secret,
  })
  expect(betaErrorDetails(error, "PublishBeta")).toEqual({
    operation: "PublishBeta",
    name: "UnknownError",
    status: null,
    code: null,
  })
  expect(JSON.stringify(betaErrorDetails(error, "PublishBeta"))).not.toContain(secret)
})

test("679 oversized error response stays bounded and unknown code never leaks body", async () => {
  const { betaErrorDetails } = await import("./beta-error")
  const value = await artifact()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response("<Error><Code>" + secret + "</Code><Message>" + secret.repeat(10000) + "</Message></Error>", {
        status: 500,
      }),
  })
  try {
    const error = await deliverBeta(bucket(server.url.origin), value.directory, value.plan).then(
      () => {
        throw new Error("Unexpected success")
      },
      (error) => error,
    )
    expect(betaErrorDetails(error, "PublishBeta")).toEqual({
      operation: "R2 GET",
      name: "Error",
      status: 500,
      code: null,
    })
    expect(JSON.stringify(betaErrorDetails(error, "PublishBeta"))).not.toContain(secret)
  } finally {
    await server.stop(true)
  }
})

test("679 HTTP error survives rollback with the original public or R2 operation", async () => {
  const { betaErrorDetails } = await import("./beta-error")
  const value = await artifact()
  for (const mode of ["public", "stored"]) {
    const old = YAML.stringify({ version: "0.1.1-beta.9" })
    const objects = new Map<string, string>([["beta/beta.yml", old]])
    const writes: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const publicRead = url.pathname.startsWith("/public/")
        const key = url.pathname.replace(/^\/(?:public\/|zaovra-updates\/)?/, "")
        if (
          key === "beta/beta.yml" &&
          objects.get(key) !== old &&
          request.method === "GET" &&
          (mode === "public" ? publicRead : !publicRead)
        )
          return new Response("<Error><Code>AccessDenied</Code><Message>" + secret + "</Message></Error>", {
            status: 403,
          })
        if (request.method === "PUT") {
          if (key === "beta/beta.yml" && objects.get(key) !== old)
            expect(request.headers.get("if-match")).toBe('"committed"')
          writes.push(key)
          objects.set(key, await request.text())
          return new Response(null, { headers: { etag: '"committed"' } })
        }
        return new Response(objects.get(key), { headers: { etag: '"previous"' } })
      },
    })
    try {
      const error = await deliverBeta(
        bucket(server.url.origin),
        value.directory,
        value.plan,
        server.url.origin + "/public/",
      ).then(
        () => {
          throw new Error("Unexpected success")
        },
        (error) => error,
      )
      expect(error.message).toContain("previous release restored")
      expect(betaErrorDetails(error, "PublishBeta")).toEqual({
        operation: mode === "public" ? "Public GET" : "R2 GET",
        name: "Error",
        status: 403,
        code: "AccessDenied",
      })
      expect(objects.get("beta/beta.yml")).toBe(old)
      expect(writes.slice(-2)).toEqual(["beta/beta.yml", "beta/beta.yml"])
      expect(JSON.stringify(betaErrorDetails(error, "PublishBeta"))).not.toContain(secret)
    } finally {
      await server.stop(true)
    }
  }
})

test("679 publishing still rejects an unavailable signing policy before any R2 request", async () => {
  const value = await artifact()
  const notes = join(value.directory, "notes.md")
  await Bun.write(notes, "offline signing guard")
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "beta-release.ts"), value.directory, sha, notes, "--publish"],
    {
      env: {
        HOME: root!,
        TEMP: root!,
        TMP: root!,
        BETA_APPROVED_SHA: sha,
        BETA_APPROVAL_REF: "offline",
        R2_ACCESS_KEY_ID: secret,
        R2_SECRET_ACCESS_KEY: secret,
        WINDOWS_SIGNING_PUBLISHER_NAME: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit).toBe(1)
  expect(stdout).toBe("")
  expect(stderr).toContain('"operation":"VerifySigningPolicy"')
  expect(stderr).not.toContain(secret)
  expect(stderr).not.toContain("Signed Windows publishing is required")
})
