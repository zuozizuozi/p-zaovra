import { S3Client, semver, YAML } from "bun"
import { createHash } from "node:crypto"
import { basename, join, resolve } from "node:path"

export const versionPattern = /^\d+\.\d+\.\d+-beta\.[1-9]\d*$/

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

export async function publishBeta(directory: string, commit: string, notes: string) {
  const plan = await planBeta(directory, commit, notes)
  if (!process.argv.includes("--publish")) {
    console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2))
    return
  }
  if (process.env.BETA_APPROVED_SHA !== commit || !process.env.BETA_APPROVAL_REF?.trim())
    throw new Error("Evaluator approval for this exact SHA is required")
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY)
    throw new Error("Minimal zaovra-updates bucket credentials are required")
  if (process.platform !== "win32" || !process.env.WINDOWS_SIGNING_PUBLISHER_NAME)
    throw new Error("Signed Windows publishing is required")
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
  if ((await signature.exited) !== 0) throw new Error("Installer signature validation failed")
  const bucket = new S3Client({
    endpoint: "https://58d97556adff19b5c088918df00c7c8c.r2.cloudflarestorage.com",
    bucket: "zaovra-updates",
    region: "auto",
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  })
  const previous = bucket.file("beta/beta.yml")
  if (await previous.exists()) {
    const old = YAML.parse(await previous.text()) as { version: string }
    if (!versionPattern.test(old.version) || semver.order(plan.manifest.version, old.version) <= 0)
      throw new Error("Beta versions must increase; do not overwrite a published version")
  }
  const indexFile = bucket.file("beta/versions.json")
  const index = (await indexFile.exists()) ? ((await indexFile.json()) as string[]) : []
  if (!Array.isArray(index) || index.some((version) => !versionPattern.test(version)))
    throw new Error("Invalid owned release index")
  for (const entry of plan.manifest.files) {
    const target = bucket.file(plan.prefix + entry.name)
    if (await target.exists()) {
      if ((await digest(target)) !== entry.sha512) throw new Error("Existing immutable artifact differs")
    } else await target.write(Bun.file(join(directory, entry.name)))
    if ((await digest(target)) !== entry.sha512) throw new Error("Uploaded artifact failed hash validation")
  }
  await bucket.file(plan.prefix + "release.json").write(JSON.stringify(plan.manifest), { type: "application/json" })
  await bucket.file(plan.prefix + "notes.md").write(notes, { type: "text/markdown" })
  // Commit the update pointer only after immutable artifacts have been uploaded and re-read.
  const pointer = await fetch(previous.presign({ method: "PUT", expiresIn: 300, type: "text/yaml" }), {
    method: "PUT",
    body: plan.metadata,
    headers: { "content-type": "text/yaml", "cache-control": "no-store, max-age=0" },
  })
  if (!pointer.ok || (await previous.text()) !== plan.metadata) throw new Error("Update pointer did not commit")
  const versions = [...new Set([...index, plan.manifest.version])]
  const retired = retiredVersions(versions, plan.manifest.version)
  for (const version of retired) {
    const prefix = "beta/" + version + "/"
    const release = (await bucket.file(prefix + "release.json").json()) as typeof plan.manifest
    if (
      release.version !== version ||
      release.files.some(
        (file) => file.name !== basename(file.name) || !/^zaovra-desktop-win-x64\.exe(?:\.blockmap)?$/.test(file.name),
      )
    )
      throw new Error("Refusing retention cleanup outside the owned release")
    for (const key of [
      ...release.files.map((file) => prefix + file.name),
      prefix + "notes.md",
      prefix + "release.json",
    ])
      await bucket.file(key).delete()
  }
  await indexFile.write(JSON.stringify(versions.filter((version) => !retired.includes(version))), {
    type: "application/json",
  })
  console.log(
    JSON.stringify({
      published: plan.manifest.version,
      commit,
      approval: process.env.BETA_APPROVAL_REF,
      retained: versions.filter((version) => !retired.includes(version)),
      retired,
    }),
  )
}

if (import.meta.main) {
  const [directory, commit, notesPath] = process.argv.slice(2).filter((value) => value !== "--publish")
  if (!directory || !commit || !notesPath)
    throw new Error("Usage: beta-release.ts <artifact-dir> <sha> <notes.md> [--publish]")
  await publishBeta(directory, commit, await Bun.file(notesPath).text()).catch(() => {
    console.error(
      "Beta delivery failed. Run the offline dry-run and verify the approved SHA, signing identity and bucket configuration. Credential details are not logged.",
    )
    process.exitCode = 1
  })
}
