import { S3Client, semver, YAML } from "bun"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { digest, retiredVersions } from "./beta-release"
import type { planBeta } from "./beta-release"

import { BetaError, betaErrorDetails, betaOperation, betaResponseError } from "./beta-error"

export const versionPattern = /^\d+\.\d+\.\d+-beta\.[1-9]\d*$/

export function nextBetaVersion(keys: string[], current?: string) {
  const versions = keys.flatMap((key) => {
    const match = /^beta\/(?:reservations\/)?(\d+\.\d+\.\d+-beta\.[1-9]\d*)(?:\/|\.json$)/.exec(key)
    return match ? [match[1]] : []
  })
  if (current) {
    if (!versionPattern.test(current)) throw new Error("Invalid current Beta version")
    versions.push(current)
  }
  if (versions.some((v) => semver.order(v, "0.1.1") >= 0)) throw new Error("A newer base version requires review")
  const numbers = versions.filter((v) => v.startsWith("0.1.1-beta.")).map((v) => Number(v.split(".").at(-1)))
  const number = Math.max(0, ...numbers) + 1
  if (!Number.isSafeInteger(number) || number > 65535)
    throw new Error("Beta counter exhausted; review the base version")
  return "0.1.1-beta." + number
}

export function continuousIdentity(env = process.env) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.EVENT_NAME !== "workflow_run" ||
    env.GITHUB_REPOSITORY !== "zuozizuozi/p-zaovra" ||
    !/^[a-f0-9]{40}$/.test(env.BETA_SOURCE_SHA ?? "") ||
    env.GITHUB_SHA !== env.BETA_SOURCE_SHA ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? "")
  )
    throw new Error("Continuous Beta requires the exact trusted main workflow identity")
  return { commit: env.BETA_SOURCE_SHA!, run: env.GITHUB_RUN_ID!, attempt: env.GITHUB_RUN_ATTEMPT! }
}

export function betaBucket() {
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) throw new Error("R2 configuration is missing")
  return new S3Client({
    endpoint: "https://58d97556adff19b5c088918df00c7c8c.r2.cloudflarestorage.com",
    bucket: "zaovra-updates",
    region: "auto",
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  })
}

async function objectRequest(
  bucket: S3Client,
  key: string,
  method: "GET" | "PUT",
  body?: Blob | string,
  headers?: HeadersInit,
) {
  return betaOperation(method === "GET" ? "R2 GET" : "R2 PUT", () =>
    fetch(bucket.presign(key, { method, expiresIn: 300 }), {
      method,
      body,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    }),
  )
}

async function pointer(bucket: S3Client) {
  const response = await objectRequest(bucket, "beta/beta.yml", "GET")
  if (response.status === 404) return { body: undefined, etag: undefined, version: undefined }
  if (!response.ok) throw await betaResponseError(response, "R2 GET", "Cannot read current Beta pointer")
  const body = await response.text()
  const metadata = YAML.parse(body) as { version?: string }
  const etag = response.headers.get("etag")
  if (!versionPattern.test(metadata?.version ?? "") || !etag) throw new Error("Invalid current Beta pointer")
  return { body, etag, version: metadata.version! }
}

export async function reserveBetaVersion(bucket: S3Client, identity: ReturnType<typeof continuousIdentity>) {
  const keys: string[] = []
  const cursors = new Set<string>()
  for (let page = 0; page < 100; page++) {
    const result = await betaOperation("R2 LIST", () =>
      bucket.list({ prefix: "beta/", maxKeys: 1000, continuationToken: [...cursors].at(-1) }),
    )
    keys.push(...(result.contents ?? []).map((entry) => entry.key))
    if (!result.isTruncated) break
    if (!result.nextContinuationToken || cursors.has(result.nextContinuationToken) || page === 99)
      throw new Error("Incomplete Beta version inventory")
    cursors.add(result.nextContinuationToken)
  }
  const previous = await pointer(bucket)
  for (let retry = 0; retry < 5; retry++) {
    const version = nextBetaVersion(keys, previous.version)
    const key = "beta/reservations/" + version + ".json"
    const response = await objectRequest(bucket, key, "PUT", JSON.stringify({ version, ...identity }), {
      "if-none-match": "*",
      "content-type": "application/json",
    })
    if (response.status === 412) {
      keys.push(key)
      continue
    }
    if (!response.ok) throw await betaResponseError(response, "R2 PUT", "Beta version reservation failed")
    return version
  }
  throw new Error("Concurrent Beta version reservations; retry a new run")
}

async function publicRead(base: string, key: string) {
  const response = await betaOperation("Public GET", () =>
    fetch(base + key + "?verify=" + crypto.randomUUID(), {
      headers: { "cache-control": "no-cache" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    }),
  )
  if (!response.ok) throw await betaResponseError(response, "Public GET", "Public Beta readback failed")
  return response
}

export async function deliverBeta(
  bucket: S3Client,
  directory: string,
  plan: Awaited<ReturnType<typeof planBeta>>,
  publicBase = "https://updates.zaovra.com/",
  identity?: ReturnType<typeof continuousIdentity>,
) {
  const previous = await pointer(bucket)
  if (previous.version && semver.order(plan.manifest.version, previous.version) <= 0)
    throw new Error("Beta versions must increase; do not overwrite a published version")
  if (identity) {
    const reservation = await objectRequest(bucket, "beta/reservations/" + plan.manifest.version + ".json", "GET")
    if (!reservation.ok) throw await betaResponseError(reservation, "R2 GET", "Missing Beta version reservation")
    const owner = (await reservation.json()) as Record<string, unknown>
    if (
      owner.version !== plan.manifest.version ||
      owner.commit !== plan.manifest.commit ||
      owner.commit !== identity.commit ||
      owner.run !== identity.run ||
      owner.attempt !== identity.attempt
    )
      throw new Error("Beta version reservation owner mismatch")
  }
  for (const entry of plan.manifest.files) {
    const key = plan.prefix + entry.name
    const put = await objectRequest(bucket, key, "PUT", Bun.file(join(directory, entry.name)), { "if-none-match": "*" })
    if (!put.ok && put.status !== 412) throw await betaResponseError(put, "R2 PUT", "Immutable Beta upload failed")
    const stored = await objectRequest(bucket, key, "GET")
    if (!stored.ok || (await digest(new Blob([await stored.arrayBuffer()]))) !== entry.sha512)
      throw stored.ok
        ? new Error("Stored Beta artifact hash mismatch")
        : await betaResponseError(stored, "R2 GET", "Stored Beta artifact hash mismatch")
    const live = await publicRead(publicBase, key)
    if ((await digest(new Blob([await live.arrayBuffer()]))) !== entry.sha512)
      throw new Error("Public Beta artifact hash mismatch")
  }
  for (const [name, body, type] of [
    ["release.json", JSON.stringify(plan.manifest), "application/json"],
    ["notes.md", plan.manifest.notes, "text/markdown"],
  ]) {
    const response = await objectRequest(bucket, plan.prefix + name, "PUT", body, {
      "if-none-match": "*",
      "content-type": type,
    })
    if (!response.ok && response.status !== 412)
      throw await betaResponseError(response, "R2 PUT", "Beta release metadata upload failed")
    const read = await objectRequest(bucket, plan.prefix + name, "GET")
    if (!read.ok || (await read.text()) !== body)
      throw read.ok
        ? new Error("Immutable Beta release metadata differs")
        : await betaResponseError(read, "R2 GET", "Immutable Beta release metadata differs")
  }
  // The pointer is the last release object written. A competing publisher cannot be overwritten.
  const commit = await objectRequest(bucket, "beta/beta.yml", "PUT", plan.metadata, {
    ...(previous.etag ? { "if-match": previous.etag } : { "if-none-match": "*" }),
    "content-type": "text/yaml",
    "cache-control": "no-store, max-age=0",
  })
  if (!commit.ok) throw await betaResponseError(commit, "R2 PUT", "Beta pointer changed; old release remains active")
  const committedETag = commit.headers.get("etag")
  try {
    const stored = await pointer(bucket)
    if (stored.body !== plan.metadata) throw new Error("Beta pointer storage readback failed")
    if ((await (await publicRead(publicBase, "beta/beta.yml")).text()) !== plan.metadata)
      throw new Error("Public Beta pointer readback failed")
  } catch (error) {
    if (previous.body && committedETag) {
      const restore = await objectRequest(bucket, "beta/beta.yml", "PUT", previous.body, {
        "if-match": committedETag,
        "content-type": "text/yaml",
        "cache-control": "no-store, max-age=0",
      })
      if (!restore.ok)
        throw await betaResponseError(
          restore,
          "R2 PUT",
          "Beta readback failed; concurrent pointer prevents rollback; inspect delivery",
        )
      if ((await pointer(bucket)).body !== previous.body)
        throw new Error("Beta rollback readback failed; inspect delivery")
      throw new BetaError(
        error instanceof BetaError ? error.operation : "VerifyBetaPointer",
        error,
        "Beta readback failed; previous release restored",
      )
    }
    throw new BetaError(
      error instanceof BetaError ? error.operation : "VerifyBetaPointer",
      error,
      "Beta pointer readback failed; inspect initial delivery",
    )
  }
}

export async function retainBetaVersions(bucket: S3Client, version: string) {
  const indexFile = bucket.file("beta/versions.json")
  const index: unknown = (await betaOperation("R2 HEAD", () => indexFile.exists()))
    ? await betaOperation("R2 GET", () => indexFile.json())
    : []
  if (
    !Array.isArray(index) ||
    index.some((value) => typeof value !== "string" || !versionPattern.test(value) || semver.order(value, version) > 0)
  )
    throw new Error("Invalid owned release index")
  const versions = [...new Set([...(index as string[]), version])]
  const retired = retiredVersions(versions, version)
  if ((await pointer(bucket)).version !== version)
    throw new Error("A newer publisher owns the pointer; defer retention")
  const owned = await Promise.all(
    retired.map(async (old) => {
      const prefix = "beta/" + old + "/"
      const release = (await betaOperation("R2 GET", () => bucket.file(prefix + "release.json").json())) as {
        version?: unknown
        files?: { name?: unknown }[]
      }
      const names = release.files?.map((file) => file.name)
      if (
        release.version !== old ||
        !names ||
        names.length !== 2 ||
        !names.includes("zaovra-desktop-win-x64.exe") ||
        !names.includes("zaovra-desktop-win-x64.exe.blockmap")
      )
        throw new Error("Refusing retention outside the owned release")
      return [...names.map((name) => prefix + name), prefix + "notes.md", prefix + "release.json"]
    }),
  )
  for (const key of owned.flat()) await betaOperation("R2 DELETE", () => bucket.file(key).delete())
  const retained = versions.filter((value) => !retired.includes(value))
  await betaOperation("R2 PUT", () => indexFile.write(JSON.stringify(retained), { type: "application/json" }))
  return { retained, retired }
}

if (import.meta.main) {
  await betaOperation("ReserveBeta", async () => {
    const identity = continuousIdentity()
    const version = await reserveBetaVersion(betaBucket(), identity)
    if (!process.env.GITHUB_ENV) throw new Error("Missing workflow environment output")
    await appendFile(process.env.GITHUB_ENV, "ZAOVRA_VERSION=" + version + "\n")
    console.log("Reserved " + version)
  }).catch((error) => {
    console.error(JSON.stringify(betaErrorDetails(error, "ReserveBeta")))
    process.exitCode = 1
  })
}
