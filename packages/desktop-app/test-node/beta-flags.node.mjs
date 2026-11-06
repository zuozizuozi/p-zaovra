import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const root = process.env.ZAOVRA_BETA_TEST_DIR
if (!root) throw new Error("Use an isolated ZAOVRA_BETA_TEST_DIR")
const sha = "a".repeat(40)
const workflow = readFileSync(join(directory, "../../.github/workflows/windows-beta.yml"), "utf8")
const calls = []
let flags
for (const line of workflow.split(/\r?\n/).map((line) => line.trim())) {
  if (/^(?:\[string\[\]\])?\$flags = /.test(line)) flags = line
  if (/^bun .*beta-release\.ts /.test(line)) calls.push({ flags, command: line })
}
assert.equal(calls.length, 3)
assert.ok(calls.every((call) => call.flags))

function powershell(body, env) {
  const result = spawnSync(
    process.env.ZAOVRA_TEST_PWSH || "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", body],
    { cwd: directory, env: { ...process.env, ...env }, encoding: "utf8", timeout: 20000 },
  )
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return result
}

for (const unsigned of [true, false]) {
  test(
    "683 workflow passes complete " + (unsigned ? "unsigned" : "signed") + " arguments through PowerShell to Bun",
    () => {
      const fixture = join(root, "flags " + randomUUID())
      mkdirSync(fixture, { recursive: true })
      const probe = join(fixture, "actual argv.ts")
      writeFileSync(probe, "console.log(JSON.stringify(process.argv.slice(2)))\n")
      for (const call of calls) {
        const command = call.command
          .replace(/^bun \S+beta-release\.ts /, "& $env:ZAOVRA_TEST_BUN $env:ZAOVRA_TEST_PROBE ")
          .replace(/\$\{\{ needs\.gate\.outputs\.sha \}\}/g, sha)
        const result = powershell(
          '$ErrorActionPreference = "Stop"\n$sha = $env:ZAOVRA_TEST_SHA\n' +
            call.flags +
            "\n" +
            command +
            "\nexit $LASTEXITCODE",
          {
            UNSIGNED_BETA: String(unsigned),
            ZAOVRA_TEST_BUN: process.env.ZAOVRA_TEST_BUN || "bun",
            ZAOVRA_TEST_PROBE: probe,
            ZAOVRA_TEST_SHA: sha,
          },
        )
        assert.equal(result.status, 0, result.stderr)
        const manual = call.command.includes("beta-artifact")
        assert.deepEqual(JSON.parse(result.stdout), [
          manual ? "beta-artifact" : "dist",
          sha,
          manual ? "beta-artifact/notes.md" : "dist/notes.md",
          ...(call.command.includes("--publish") ? ["--publish"] : []),
          ...(call.command.includes("--continuous") ? ["--continuous"] : []),
          ...(unsigned ? ["--allow-unsigned-beta"] : []),
        ])
      }
    },
  )
}

for (const policy of ["unsigned", "signed", "reject-prod"]) {
  test("683 workflow flags reach the real release CLI: " + policy, () => {
    const fixture = join(root, "release flags " + randomUUID())
    mkdirSync(fixture, { recursive: true })
    const installer = "synthetic, never executed installer"
    const sha512 = createHash("sha512").update(installer).digest("base64")
    writeFileSync(join(fixture, "zaovra-desktop-win-x64.exe"), installer)
    writeFileSync(join(fixture, "zaovra-desktop-win-x64.exe.blockmap"), "synthetic blockmap")
    writeFileSync(join(fixture, "notes.md"), "Offline flag transport regression")
    writeFileSync(
      join(fixture, "beta.yml"),
      JSON.stringify({
        version: "0.1.1-beta.10",
        path: "zaovra-desktop-win-x64.exe",
        sha512,
        files: [{ url: "zaovra-desktop-win-x64.exe", size: Buffer.byteLength(installer), sha512 }],
      }),
    )
    const result = powershell(
      '$ErrorActionPreference = "Stop"\n' +
        calls[0].flags +
        "\n& $env:ZAOVRA_TEST_BUN scripts/beta-release.ts $env:ZAOVRA_TEST_ARTIFACT $env:ZAOVRA_TEST_SHA $env:ZAOVRA_TEST_NOTES @flags\nexit $LASTEXITCODE",
      {
        UNSIGNED_BETA: String(policy !== "signed"),
        ZAOVRA_CHANNEL: policy === "reject-prod" ? "prod" : "beta",
        ZAOVRA_TEST_BUN: process.env.ZAOVRA_TEST_BUN || "bun",
        ZAOVRA_TEST_ARTIFACT: fixture,
        ZAOVRA_TEST_SHA: sha,
        ZAOVRA_TEST_NOTES: join(fixture, "notes.md"),
      },
    )
    if (policy === "reject-prod") {
      assert.equal(result.status, 1, result.stdout + result.stderr)
      assert.equal(result.stdout, "")
      assert.match(result.stderr, /"operation":"VerifySigningPolicy"/)
      return
    }
    assert.equal(result.status, 0, result.stderr)
    const plan = JSON.parse(result.stdout)
    assert.equal(plan.dryRun, true)
    assert.equal(plan.signingPolicy, policy === "unsigned" ? "unsigned beta" : "Valid signature required")
    assert.equal(plan.manifest.commit, sha)
    assert.equal(plan.manifest.version, "0.1.1-beta.10")
  })
}
