import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { planBeta, retiredVersions } from "./beta-release"
import { verifyBetaCI } from "./beta-ci"

const root = process.env.ZAOVRA_BETA_TEST_DIR
if (!root) throw new Error("Use an isolated ZAOVRA_BETA_TEST_DIR")
const sha = "a".repeat(40)
async function fixture() {
  const directory = join(root!, crypto.randomUUID())
  await mkdir(directory, { recursive: true })
  const body = "synthetic installer fixture"
  const sha512 = createHash("sha512").update(body).digest("base64")
  await Bun.write(join(directory, "zaovra-desktop-win-x64.exe"), body)
  await Bun.write(join(directory, "zaovra-desktop-win-x64.exe.blockmap"), "fixture blockmap")
  const metadata = {
    version: "0.1.0-beta.10",
    path: "zaovra-desktop-win-x64.exe",
    sha512,
    files: [{ url: "zaovra-desktop-win-x64.exe", size: Buffer.byteLength(body), sha512 }],
  }
  await Bun.write(join(directory, "beta.yml"), Bun.YAML.stringify(metadata))
  return { directory, metadata }
}

test("dry plan re-hashes actual files and points metadata into its immutable version directory", async () => {
  const value = await fixture()
  const plan = await planBeta(value.directory, sha, "Reviewable notes")
  const metadata = Bun.YAML.parse(plan.metadata) as { path: string }
  expect(metadata.path).toBe("0.1.0-beta.10/zaovra-desktop-win-x64.exe")
  expect(plan.manifest.commit).toBe(sha)
  expect(plan.manifest.files).toHaveLength(2)
  await Bun.write(join(value.directory, value.metadata.path), "tampered")
  await expect(planBeta(value.directory, sha, "notes")).rejects.toThrow("does not match")
})

test("external and traversal metadata cannot become upload or retention paths", async () => {
  const value = await fixture()
  value.metadata.files[0].url = "../private.txt"
  value.metadata.path = "../private.txt"
  await Bun.write(join(value.directory, "beta.yml"), Bun.YAML.stringify(value.metadata))
  await expect(planBeta(value.directory, sha, "notes")).rejects.toThrow("Unexpected installer")
  expect(() => retiredVersions(["../../private", "0.1.0-beta.10"], "0.1.0-beta.10")).toThrow()
})

test("retention keeps five numeric semver releases, including 10 after 9", () => {
  const versions = [1, 2, 8, 9, 10, 11].map((value) => "0.1.0-beta." + value)
  expect(retiredVersions(versions, "0.1.0-beta.11")).toEqual(["0.1.0-beta.1"])
})

test("exact main CI gate rejects stale successful, failed latest and other SHA checks", () => {
  const run = (name: string, number: number, conclusion = "success", head = sha) => ({
    name,
    run_number: number,
    run_attempt: 1,
    head_sha: head,
    head_branch: "main",
    event: "push",
    repository: { full_name: "zuozizuozi/p-zaovra" },
    status: "completed",
    conclusion,
  })
  expect(() => verifyBetaCI({ workflow_runs: [run("test", 1), run("typecheck", 1)] }, sha)).not.toThrow()
  expect(() =>
    verifyBetaCI({ workflow_runs: [run("test", 1), run("test", 2, "failure"), run("typecheck", 1)] }, sha),
  ).toThrow()
  expect(() =>
    verifyBetaCI({ workflow_runs: [run("test", 1, "success", "b".repeat(40)), run("typecheck", 1)] }, sha),
  ).toThrow()
  const already = { ...run("windows-beta", 1), event: "workflow_run", id: 99 }
  const metadata = { workflow_runs: [run("test", 1), run("typecheck", 1), already] }
  expect(verifyBetaCI(metadata, sha, 100)).toBe(true)
  expect(verifyBetaCI(metadata, sha, 99)).toBe(false)
})
