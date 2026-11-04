import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

export function betaSigningPolicy(event: string | undefined, unsigned: unknown) {
  if (typeof unsigned !== "boolean") throw new Error("unsigned_beta must be a boolean")
  if (unsigned && event !== "workflow_dispatch") throw new Error("Unsigned Beta requires explicit manual dispatch")
  return { channel: "beta", signingPolicy: unsigned ? "unsigned-beta" : "signed", unsignedBeta: unsigned } as const
}

export function verifyBetaSigning(gate: unknown, pkg: unknown, sha: string, unsigned: boolean, digest: string) {
  if (!gate || typeof gate !== "object" || !pkg || typeof pkg !== "object")
    throw new Error("Missing Beta signing metadata")
  const policy = betaSigningPolicy("workflow_dispatch", unsigned)
  const record = gate as Record<string, unknown>
  const metadata = pkg as Record<string, unknown>
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    record.commit !== sha ||
    record.installerSHA256 !== digest ||
    record.channel !== policy.channel ||
    record.signingPolicy !== policy.signingPolicy ||
    record.unsignedBeta !== policy.unsignedBeta ||
    metadata.zaovraChannel !== "beta" ||
    metadata.zaovraUnsignedBeta !== unsigned ||
    metadata.zaovraSourceSHA !== sha
  )
    throw new Error("Requested signing policy, reviewed artifact and packaged identity differ")
  return policy
}

export async function readBetaPackage(asar: string) {
  const { extractFile } = await import("@electron/asar")
  return JSON.parse(extractFile(asar, "package.json").toString("utf8")) as unknown
}

export async function installerPackage(installer: string, root = process.env.RUNNER_TEMP, sevenZip = "7z") {
  if (!root) throw new Error("An isolated runner temporary directory is required")
  const temp = await mkdtemp(join(root, "beta-policy-"))
  try {
    // Static archive reads only: never launch an installer or extracted application.
    const extract = async (archive: string, entry: string, target: string) => {
      const child = Bun.spawn([sevenZip, "e", "-so", archive, entry], { stdout: Bun.file(target), stderr: "pipe" })
      await new Response(child.stderr).text()
      if ((await child.exited) !== 0 || !(await Bun.file(target).size))
        throw new Error("Cannot inspect packaged Beta identity")
    }
    await extract(installer, "$PLUGINSDIR/app-64.7z", join(temp, "app.7z"))
    await extract(join(temp, "app.7z"), "resources/app.asar", join(temp, "app.asar"))
    return await readBetaPackage(join(temp, "app.asar"))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const [mode, directory, sha] = process.argv.slice(2)
  const raw = process.env.UNSIGNED_BETA ?? "false"
  if (!["true", "false"].includes(raw)) throw new Error("unsigned_beta must be a boolean")
  const policy = betaSigningPolicy(process.env.EVENT_NAME, raw === "true")
  const path = join(directory, "ci-gate.json")
  const gate = await Bun.file(path).json()
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(join(directory, "zaovra-desktop-win-x64.exe")).arrayBuffer())
    .digest("hex")
  if (!["build", "publish"].includes(mode)) throw new Error("Unknown signing verification mode")
  const pkg =
    mode === "build"
      ? await readBetaPackage(join(directory, "win-unpacked/resources/app.asar"))
      : await installerPackage(join(directory, "zaovra-desktop-win-x64.exe"))
  const metadata = mode === "build" ? { ...gate, ...policy, installerSHA256: digest } : gate
  verifyBetaSigning(metadata, pkg, sha, policy.unsignedBeta, digest)
  if (mode === "build") await Bun.write(path, JSON.stringify(metadata, null, 2))
  console.log(policy.unsignedBeta ? "未签名Beta: explicit reviewed exception" : "Signed Windows Beta")
}
