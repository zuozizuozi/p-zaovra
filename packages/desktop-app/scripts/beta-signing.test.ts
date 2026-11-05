import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { betaSigningPolicy, readBetaPackage, installerPackage, verifyBetaSigning } from "./beta-signing"
const sha = "a".repeat(40),
  digest = "b".repeat(64)
for (const unsigned of [false, true]) {
  test("609 reviewed signing policy " + unsigned, () => {
    const policy = betaSigningPolicy("workflow_dispatch", unsigned)
    const gate = { commit: sha, installerSHA256: digest, ...policy }
    const pkg = { zaovraChannel: "beta", zaovraUnsignedBeta: unsigned, zaovraSourceSHA: sha }
    expect(verifyBetaSigning(gate, pkg, sha, unsigned, digest)).toEqual(policy)
    for (const wrong of [undefined, "true", !unsigned])
      expect(() => verifyBetaSigning({ ...gate, unsignedBeta: wrong }, pkg, sha, unsigned, digest)).toThrow()
    for (const wrong of [undefined, "true", !unsigned])
      expect(() => verifyBetaSigning(gate, { ...pkg, zaovraUnsignedBeta: wrong }, sha, unsigned, digest)).toThrow()
    for (const change of [
      { channel: "prod" },
      { commit: "c".repeat(40) },
      { installerSHA256: "d".repeat(64) },
      { signingPolicy: "other" },
    ])
      expect(() => verifyBetaSigning({ ...gate, ...change }, pkg, sha, unsigned, digest)).toThrow()
    expect(() => verifyBetaSigning(gate, { ...pkg, zaovraChannel: "prod" }, sha, unsigned, digest)).toThrow()
    expect(() => verifyBetaSigning(gate, { ...pkg, zaovraSourceSHA: "c".repeat(40) }, sha, unsigned, digest)).toThrow()
    expect(() => verifyBetaSigning(gate, pkg, sha, !unsigned, digest)).toThrow()
  })
}
test("646 automatic Beta policy stays strict for other events and malformed unsigned", () => {
  for (const event of [undefined, "push", "pull_request"]) expect(() => betaSigningPolicy(event, true)).toThrow()
  for (const value of [undefined, null, 0, 1, "false", "true"])
    expect(() => betaSigningPolicy("workflow_dispatch", value)).toThrow()
  expect(betaSigningPolicy("workflow_run", false).signingPolicy).toBe("signed")
  expect(betaSigningPolicy("workflow_run", true).signingPolicy).toBe("unsigned-beta")
})
test("609 reads identity from a real ASAR without running packaged code", async () => {
  if (!process.env.ZAOVRA_BETA_TEST_DIR) throw new Error("Isolated fixtures required")
  const root = join(process.env.ZAOVRA_BETA_TEST_DIR, crypto.randomUUID())
  await mkdir(join(root, "package"), { recursive: true })
  const metadata = { zaovraChannel: "beta", zaovraUnsignedBeta: true, zaovraSourceSHA: sha }
  await Bun.write(join(root, "package/package.json"), JSON.stringify(metadata))
  const { createPackage } = await import("@electron/asar")
  await createPackage(join(root, "package"), join(root, "app.asar"))
  expect(await readBetaPackage(join(root, "app.asar"))).toEqual(metadata)
})
test("609 workflow keeps manual publishing protected and Azure signed-only", async () => {
  const y = Bun.YAML.parse(
    await Bun.file(join(import.meta.dir, "../../../.github/workflows/windows-beta.yml")).text(),
  ) as {
    on: { workflow_dispatch: { inputs: { unsigned_beta: { default: boolean } } } }
    jobs: Record<
      string,
      {
        environment?: string
        env?: Record<string, string>
        steps: Array<{ name?: string; uses?: string; if?: string; env?: Record<string, string>; run?: string }>
      }
    >
  }
  expect(y.on.workflow_dispatch.inputs.unsigned_beta.default).toBe(false)
  expect(y.jobs.publish.environment).toBe("beta-publish")
  expect(Object.keys(y.jobs.build.env ?? {}).some((k) => k.startsWith("AZURE"))).toBe(false)
  const azure = y.jobs.build.steps.find((s) => s.uses?.startsWith("azure/login"))!
  expect(azure.if).toContain("!= 'true'")
  const steps = y.jobs.publish.steps
  const policy = steps.findIndex((s) => s.run?.includes("beta-signing.ts publish"))
  const fresh = steps.findIndex((s) => s.run?.includes("beta-ci.ts"))
  const publish = steps.findIndex((s) => s.env?.R2_ACCESS_KEY_ID)
  expect(policy).toBeGreaterThan(0)
  expect(fresh).toBeGreaterThan(policy)
  expect(publish).toBeGreaterThan(fresh)
  expect(steps[publish].run).toContain("--allow-unsigned-beta")
})

test("609 statically inspects nested installer archives without executing them", async () => {
  if (!process.env.ZAOVRA_BETA_TEST_DIR) throw new Error("Isolated fixture root required")
  const root = join(process.env.ZAOVRA_BETA_TEST_DIR, crypto.randomUUID())
  await mkdir(join(root, "package"), { recursive: true })
  await mkdir(join(root, "payload/resources"), { recursive: true })
  await mkdir(join(root, "outer/$PLUGINSDIR"), { recursive: true })
  const pkg = { zaovraChannel: "beta", zaovraUnsignedBeta: true, zaovraSourceSHA: sha }
  await Bun.write(join(root, "package/package.json"), JSON.stringify(pkg))
  const { createPackage } = await import("@electron/asar")
  const { path7za } = await import("7zip-bin")
  await createPackage(join(root, "package"), join(root, "payload/resources/app.asar"))
  for (const [cwd, args] of [
    [join(root, "payload"), ["a", "-t7z", join(root, "outer/$PLUGINSDIR/app-64.7z"), "resources/app.asar"]],
    [join(root, "outer"), ["a", "-tzip", join(root, "synthetic-installer.exe"), "$PLUGINSDIR/app-64.7z"]],
  ] as const) {
    const child = Bun.spawn([path7za, ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, out + err).toBe(0)
  }
  expect(await installerPackage(join(root, "synthetic-installer.exe"), root, path7za)).toEqual(pkg)
})

test("646 package version must match the update pointer and signing gate", () => {
  const version = "0.1.1-beta.4"
  const policy = betaSigningPolicy("workflow_run", true)
  const gate = { commit: sha, installerSHA256: digest, version, ...policy }
  const pkg = { zaovraChannel: "beta", zaovraUnsignedBeta: true, zaovraSourceSHA: sha, version }
  expect(verifyBetaSigning(gate, pkg, sha, true, digest, version).unsignedBeta).toBe(true)
  expect(() => verifyBetaSigning(gate, { ...pkg, version: "0.1.1-beta.3" }, sha, true, digest, version)).toThrow(
    "version",
  )
  expect(() => verifyBetaSigning({ ...gate, version: "0.1.1-beta.3" }, pkg, sha, true, digest, version)).toThrow(
    "version",
  )
})
