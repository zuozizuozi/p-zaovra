import { expect, test } from "bun:test"
import path from "node:path"

const windows = process.platform === "win32" ? test : test.skip

for (const target of [path.join(import.meta.dir, "missing-signing-fixture.exe"), import.meta.dir]) {
  windows(`CI rejects invalid signing target ${path.basename(target)}`, async () => {
    const child = Bun.spawn(
      [
        "pwsh",
        "-NoLogo",
        "-NoProfile",
        "-File",
        path.resolve(import.meta.dir, "../../../script/sign-windows.ps1"),
        target,
      ],
      {
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          AZURE_TRUSTED_SIGNING_ENDPOINT: "https://example.invalid",
          AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "fixture",
          AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE: "fixture",
          WINDOWS_SIGNING_PUBLISHER_NAME: "Fixture Publisher",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stdout + stderr).not.toBe(0)
    expect(stdout + stderr).toContain(target)
    expect(stdout + stderr).not.toContain("Install-Module")
  })
}

for (const partial of [false, true]) {
  windows(`CI rejects ${partial ? "partial" : "missing"} Windows signing configuration`, async () => {
    const child = Bun.spawn(
      [
        "pwsh",
        "-NoLogo",
        "-NoProfile",
        "-File",
        path.resolve(import.meta.dir, "../../../script/sign-windows.ps1"),
        "fixture.exe",
      ],
      {
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          AZURE_TRUSTED_SIGNING_ENDPOINT: partial ? "https://example.invalid" : "",
          AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "",
          AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stdout + stderr).not.toBe(0)
    expect(stdout + stderr).toContain("Windows signing configuration is incomplete")
  })
}

windows("CI rejects a missing publisher before resolving a signing target", async () => {
  const child = Bun.spawn(
    [
      "pwsh",
      "-NoLogo",
      "-NoProfile",
      "-File",
      path.resolve(import.meta.dir, "../../../script/sign-windows.ps1"),
      "fixture.exe",
    ],
    {
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        AZURE_TRUSTED_SIGNING_ENDPOINT: "https://example.invalid",
        AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "fixture",
        AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE: "fixture",
        WINDOWS_SIGNING_PUBLISHER_NAME: " ",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code).not.toBe(0)
  expect(stdout + stderr).toContain("Windows signing configuration is incomplete")
  expect(stdout + stderr).toContain("publisher name")
})
