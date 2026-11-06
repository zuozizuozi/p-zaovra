import { semver, YAML } from "bun"
import { createHash } from "node:crypto"
import { basename, join, resolve } from "node:path"

import { betaBucket, continuousIdentity, deliverBeta, retainBetaVersions, versionPattern } from "./beta-storage"
import { BetaError, betaErrorDetails, betaOperation } from "./beta-error"
export { versionPattern } from "./beta-storage"

export async function digest(file: Blob) {
  const hash = createHash("sha512")
  for await (const chunk of file.stream()) hash.update(chunk)
  return hash.digest("base64")
}

export async function planBeta(directory: string, commit: string, notes: string) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("An exact source commit is required")
  if (!notes.trim() || notes.length > 20_000) throw new Error("Release notes are required")
  const metadata = YAML.parse(await Bun.file(join(directory, "beta.yml")).text()) as {
    version: string
    files: { url: string; sha512: string; size: number }[]
    path: string
    sha512: string
  }
  if (!versionPattern.test(metadata.version) || !Array.isArray(metadata.files) || metadata.files.length !== 1)
    throw new Error("Expected one Windows Beta installer")
  const entry = metadata.files[0]
  if (
    !/^zaovra-desktop-win-x64\.exe$/.test(entry.url) ||
    entry.url !== metadata.path ||
    entry.sha512 !== metadata.sha512
  )
    throw new Error("Unexpected installer path or hash")
  const installer = Bun.file(join(directory, entry.url))
  if (!(await installer.exists()) || installer.size !== entry.size || (await digest(installer)) !== entry.sha512)
    throw new Error("Installer does not match beta.yml")
  const blockmap = Bun.file(join(directory, entry.url + ".blockmap"))
  if (!(await blockmap.exists()) || blockmap.size <= 0) throw new Error("Installer blockmap is missing")
  const prefix = "beta/" + metadata.version + "/"
  const files = await Promise.all(
    [installer, blockmap].map(async (file) => ({
      name: basename(file.name!),
      size: file.size,
      sha512: await digest(file),
    })),
  )
  const manifest = { version: metadata.version, commit, notes, files, created: new Date().toISOString() }
  return {
    manifest,
    prefix,
    metadata: YAML.stringify({
      ...metadata,
      files: [{ ...entry, url: metadata.version + "/" + entry.url }],
      path: metadata.version + "/" + entry.url,
      releaseNotes: notes,
      releaseDate: manifest.created,
    }),
  }
}

export function retiredVersions(versions: string[], current: string) {
  if (versions.some((version) => !versionPattern.test(version)) || !versions.includes(current))
    throw new Error("Invalid owned release index")
  return [...new Set(versions)].sort((a, b) => semver.order(b, a)).slice(5)
}

export function unsignedBeta(args: string[], channel: string | undefined) {
  if (!args.includes("--allow-unsigned-beta")) return false
  if (channel !== "beta") throw new Error("--allow-unsigned-beta requires ZAOVRA_CHANNEL=beta")
  return true
}

export async function publishBeta(directory: string, commit: string, notes: string) {
  const unsigned = await betaOperation("VerifySigningPolicy", () =>
    unsignedBeta(process.argv, process.env.ZAOVRA_CHANNEL),
  )
  const plan = await betaOperation("PlanBeta", () => planBeta(directory, commit, notes))
  if (!process.argv.includes("--publish")) {
    console.log(
      JSON.stringify(
        { dryRun: true, signingPolicy: unsigned ? "unsigned beta" : "Valid signature required", ...plan },
        null,
        2,
      ),
    )
    return
  }
  const continuous = process.argv.includes("--continuous")
  const identity = continuous ? await betaOperation("ValidatePublishIdentity", continuousIdentity) : undefined
  if (identity && (identity.commit !== commit || process.env.ZAOVRA_VERSION !== plan.manifest.version))
    throw new BetaError("ValidatePublishIdentity", new Error("Continuous Beta version or source identity mismatch"))
  if (!continuous && (process.env.BETA_APPROVED_SHA !== commit || !process.env.BETA_APPROVAL_REF?.trim()))
    throw new BetaError("ValidatePublishIdentity", new Error("Evaluator approval for this exact SHA is required"))
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY)
    throw new BetaError("ConfigureR2Bucket", new Error("Minimal zaovra-updates bucket credentials are required"))
  if (process.platform !== "win32")
    throw new BetaError("VerifySigningPolicy", new Error("Windows publishing is required"))
  if (unsigned) console.log("unsigned beta")
  if (!unsigned) {
    if (!process.env.WINDOWS_SIGNING_PUBLISHER_NAME)
      throw new BetaError("VerifySigningPolicy", new Error("Signed Windows publishing is required"))
    const signature = Bun.spawn(
      [
        "pwsh",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(import.meta.dir, "verify-beta-signature.ps1"),
        "-Installer",
        resolve(directory, plan.manifest.files[0].name),
        "-Publisher",
        process.env.WINDOWS_SIGNING_PUBLISHER_NAME,
      ],
      { stdout: "inherit", stderr: "inherit" },
    )
    if ((await signature.exited) !== 0)
      throw new BetaError("VerifySigningPolicy", new Error("Installer signature validation failed"))
  }
  const bucket = await betaOperation("ConfigureR2Bucket", betaBucket)
  await deliverBeta(bucket, directory, plan, undefined, identity)
  const retention = await retainBetaVersions(bucket, plan.manifest.version).catch((error) => {
    console.warn(JSON.stringify(betaErrorDetails(error, "Retention")))
    console.warn("Beta is published and verified; old-version retention is deferred. Credentials are not logged.")
    return { deferred: true }
  })

  console.log(
    JSON.stringify({
      published: plan.manifest.version,
      signing: unsigned ? "unsigned beta" : "Valid signature",
      commit,
      approval: process.env.BETA_APPROVAL_REF,
      retention,
    }),
  )
}

if (import.meta.main) {
  const [directory, commit, notesPath] = process.argv
    .slice(2)
    .filter((value) => value !== "--publish" && value !== "--allow-unsigned-beta" && value !== "--continuous")
  if (!directory || !commit || !notesPath)
    throw new Error("Usage: beta-release.ts <artifact-dir> <sha> <notes.md> [--publish] [--allow-unsigned-beta]")
  await betaOperation("ReadReleaseNotes", () => Bun.file(notesPath).text())
    .then((notes) => publishBeta(directory, commit, notes))
    .catch((error) => {
      console.error(JSON.stringify(betaErrorDetails(error, "PublishBeta")))
      console.error(
        "Beta delivery failed. Run the offline dry-run and verify the approved SHA, signing policy and bucket configuration. Credential details are not logged.",
      )
      process.exitCode = 1
    })
}
