import { afterAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const fixtures: string[] = []
const temporary = path.resolve(process.env.ZAOVRA_BETA_TEST_DIR ?? os.tmpdir())

afterAll(async () => {
  for (const fixture of fixtures) {
    if (!fixture.startsWith(temporary + path.sep)) throw new Error("Fixture escaped temporary directory")
    await rm(fixture, { recursive: true, force: true })
  }
})

async function desktop(dependencies: Record<string, string>, optionalDependencies = {}) {
  await mkdir(temporary, { recursive: true })
  const fixture = await mkdtemp(path.join(temporary, "notices-"))
  fixtures.push(fixture)
  const root = path.join(fixture, "packages/desktop-app")
  await Bun.write(path.join(root, "scripts/notices.ts"), Bun.file(path.join(import.meta.dir, "notices.ts")))
  await Bun.write(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@zaovra-ai/desktop", version: "0.1.0", dependencies, optionalDependencies }),
  )
  await Bun.write(path.join(root, "resources/licenses/Zaovra-MIT.txt"), "MIT workspace license")
  for (const input of ["out/main", "out/preload", "out/renderer", "../zaovra/dist/node"]) {
    await Bun.write(path.join(root, input, "notices-inputs.json"), "[]")
  }
  return { fixture, root }
}

async function notices(root: string) {
  const child = Bun.spawn([process.execPath, path.join(root, "scripts/notices.ts")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exit }
}

test("postbuild resolves hoisted Schema with private unversioned and manifest-hidden exports", async () => {
  const fixture = await desktop({ "@zaovra-ai/schema": "workspace:*" })
  const schema = path.join(fixture.fixture, "node_modules/@zaovra-ai/schema")
  await Bun.write(
    path.join(schema, "package.json"),
    Bun.file(path.resolve(import.meta.dir, "../../schema/package.json")),
  )
  await Bun.write(
    path.join(schema, "src/index.ts"),
    'throw new Error("Notice collection must not execute package code")',
  )
  await Bun.write(
    path.join(fixture.fixture, "node_modules/effect/package.json"),
    JSON.stringify({ name: "effect", version: "4.0.0-beta.83", license: "MIT" }),
  )
  await Bun.write(path.join(fixture.fixture, "node_modules/effect/LICENSE"), "MIT effect license")
  const result = await notices(fixture.root)
  expect(result.stderr).toBe("")
  expect(result.exit).toBe(0)
  const output = await Bun.file(path.join(fixture.root, "resources/THIRD_PARTY_NOTICES.txt")).text()
  expect(output).toContain("@zaovra-ai/schema workspace")
  expect(output).toContain("effect 4.0.0-beta.83")
  expect(output).toContain("MIT workspace license")
  expect(output).toContain("MIT effect license")
  expect(output).not.toContain("undefined")
})

test("postbuild still rejects a missing required dependency", async () => {
  const fixture = await desktop({ "@zaovra-ai/schema": "workspace:*" })
  const result = await notices(fixture.root)
  expect(result.exit).not.toBe(0)
  expect(result.stderr).toContain("Missing packaged dependency: @zaovra-ai/schema")
  expect(await Bun.file(path.join(fixture.root, "resources/THIRD_PARTY_NOTICES.txt")).exists()).toBe(false)
})

test("postbuild tolerates an absent optional dependency", async () => {
  const fixture = await desktop({}, { "optional-not-installed": "1.0.0" })
  const result = await notices(fixture.root)
  expect(result.stderr).toBe("")
  expect(result.exit).toBe(0)
  const output = await Bun.file(path.join(fixture.root, "resources/THIRD_PARTY_NOTICES.txt")).text()
  expect(output).toContain("@zaovra-ai/desktop 0.1.0")
  expect(output).not.toContain("optional-not-installed")
})

test("postbuild attributes an unversioned vendor subpath to its versioned package", async () => {
  const fixture = await desktop({})
  const vendor = path.join(fixture.fixture, "node_modules/solid-js")
  await Bun.write(
    path.join(vendor, "package.json"),
    JSON.stringify({ name: "solid-js", version: "1.9.10", license: "MIT" }),
  )
  await Bun.write(path.join(vendor, "LICENSE"), "MIT solid license")
  await Bun.write(path.join(vendor, "store/package.json"), JSON.stringify({ name: "solid-js/store" }))
  const entry = path.join(vendor, "store/dist/store.js")
  await Bun.write(entry, 'throw new Error("Notice collection must not execute bundled code")')
  await Bun.write(path.join(fixture.root, "out/main/notices-inputs.json"), JSON.stringify([entry]))
  const result = await notices(fixture.root)
  expect(result.exit).toBe(0)
  const output = await Bun.file(path.join(fixture.root, "resources/THIRD_PARTY_NOTICES.txt")).text()
  expect(output).toContain("solid-js 1.9.10")
  expect(output).toContain("MIT solid license")
  expect(output).not.toContain("solid-js/store workspace")
})
