import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, readdir, symlink } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { tmpdir } from "../fixture/fixture"

async function run(input: {
  rest?: number
  footer?: number
  scrollback?: number
  args?: string[]
  failure?: boolean
  extra?: number
  empty?: boolean
  loadError?: boolean
  domains?: boolean
}) {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "script/test.ts"), Bun.file(new URL("../../script/test.ts", import.meta.url)))
  await Bun.write(
    path.join(tmp.path, "script/test-report.ts"),
    Bun.file(new URL("../../script/test-report.ts", import.meta.url)),
  )
  await mkdir(path.join(tmp.path, "node_modules"), { recursive: true })
  await symlink(
    path.resolve(path.dirname(fileURLToPath(import.meta.resolve("htmlparser2"))), "../.."),
    path.join(tmp.path, "node_modules/htmlparser2"),
    "junction",
  )
  const fixture = (name: string, exit = 0) => `
import { expect, test } from "bun:test"
import { appendFileSync } from "node:fs"
test(${JSON.stringify(name)}, () => {
  appendFileSync(${JSON.stringify(path.join(tmp.path, "executed"))}, ${JSON.stringify(name + "\n")})
  if (${input.domains ?? false} && ${JSON.stringify(name)} === "producer") process.env.ZAOVRA_TEST_RUNNER_DOMAIN_LEAK = "set"
  if (${input.domains ?? false} && ${JSON.stringify(name)} === "consumer") expect(process.env.ZAOVRA_TEST_RUNNER_DOMAIN_LEAK).toBeUndefined()
  if (${input.failure ?? false} && ${JSON.stringify(name)} === "rest") expect(1).toBe(2)
  if (${exit}) process.exit(${exit})
})
if (${input.loadError ?? false} && ${JSON.stringify(name)} === "rest") throw new Error("module registration failed")
`
  await Bun.write(path.join(tmp.path, "test/rest.test.ts"), fixture("rest", input.rest))
  if (input.empty) await Bun.write(path.join(tmp.path, "test/empty.test.ts"), "export {}\n")
  if (input.domains) {
    await Bun.write(path.join(tmp.path, "test/alpha/producer.test.ts"), fixture("producer"))
    await Bun.write(path.join(tmp.path, "test/beta/consumer.test.ts"), fixture("consumer"))
  }
  for (const index of Array.from({ length: input.extra ?? 0 }, (_, index) => index)) {
    await Bun.write(path.join(tmp.path, `test/extra-${index}.test.ts`), fixture(`extra-${index}`))
  }
  if (input.scrollback !== undefined)
    await Bun.write(
      path.join(tmp.path, "test/cli/run/scrollback.surface.test.ts"),
      fixture("scrollback", input.scrollback),
    )
  await Bun.write(path.join(tmp.path, "test/cli/run/footer.view.test.tsx"), fixture("footer", input.footer))
  const child = Bun.spawn([process.execPath, "--no-env-file", "run", "script/test.ts", ...(input.args ?? [])], {
    cwd: tmp.path,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ZAOVRA_TEST_REPORT_DIR: path.join(tmp.path, "reports") },
  })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return {
    exit,
    output: stdout + stderr,
    executed: (await Bun.file(path.join(tmp.path, "executed")).text()).trim().split("\n"),
    reports: await readdir(path.join(tmp.path, "reports"))
      .then(async (files) => {
        const dir = path.join(tmp.path, "reports", files[0])
        return {
          plan: await Bun.file(path.join(dir, "plan.json")).json(),
          results: await Bun.file(path.join(dir, "results.json")).json(),
          inventory: await Bun.file(path.join(dir, "package-manifest.json"))
            .json()
            .catch(() => undefined),
          actual: await Bun.file(path.join(dir, "package.xml"))
            .text()
            .catch(() => undefined),
          inventoryLog: await Bun.file(path.join(dir, "package-inventory.log")).text(),
        }
      })
      .catch(() => undefined),
  }
}

test("default package runner executes every file once in separate groups", async () => {
  const result = await run({})
  expect(result.exit).toBe(0)
  expect(result.executed).toEqual(["rest", "footer"])
  expect(result.output).toContain("test:package exit=0")
  expect(result.output).toContain("test:footer exit=0")
  expect(result.reports?.plan.files).toEqual(["test/cli/run/footer.view.test.tsx", "test/rest.test.ts"])
  expect(result.reports?.inventory).toEqual({ files: [{ file: "test/rest.test.ts", tests: 1 }], tests: 1, empty: [] })
  expect(result.reports?.actual).toContain('<testsuites name="bun test" tests="1"')
  expect(result.reports?.results.map((group: { code: number }) => group.code)).toEqual([0, 0])
})

test("a package process failure still runs and reports the footer process", async () => {
  const result = await run({ rest: 23 })
  expect(result.exit).toBe(1)
  expect(result.executed).toEqual(["rest", "footer"])
  expect(result.output).toContain("test:package exit=23")
  expect(result.output).toContain("test:footer exit=0")
})

test("a footer process failure preserves the package summary and fails the command", async () => {
  const result = await run({ footer: 23 })
  expect(result.exit).toBe(1)
  expect(result.executed).toEqual(["rest", "footer"])
  expect(result.output).toContain("test:package exit=0")
  expect(result.output).toContain("test:footer exit=23")
})

test("explicit focused package arguments retain Bun file filtering", async () => {
  const result = await run({ args: ["./test/rest.test.ts"] })
  expect(result.exit).toBe(0)
  expect(result.executed).toEqual(["rest"])
  expect(result.output).toContain("test:selected exit=0")
  expect(result.output).not.toContain("test:footer starting")
  expect(result.reports).toBeUndefined()
})

test("a real assertion failure keeps its report and still runs the footer", async () => {
  const result = await run({ failure: true })
  expect(result.exit).toBe(1)
  expect(result.executed).toEqual(["rest", "footer"])
  expect(result.reports?.actual).toContain('failures="1"')
  expect(result.reports?.results.map((group: { code: number }) => group.code)).toEqual([1, 0])
})

test("bounded groups retain every discovered file exactly once", async () => {
  const result = await run({ extra: 64 })
  expect(result.exit).toBe(0)
  expect(result.executed).toHaveLength(66)
  expect(new Set(result.executed).size).toBe(66)
  expect(result.reports?.plan.groups.map((group: { files: string[] }) => group.files.length)).toEqual([24, 24, 17, 1])
  expect(result.reports?.results.map((group: { code: number }) => group.code)).toEqual([0, 0, 0, 0])
})

test("empty source files remain in the manifest with compiler and byte proof", async () => {
  const result = await run({ empty: true })
  expect(result.exit).toBe(0)
  expect(result.executed).toEqual(["rest", "footer"])
  expect(result.reports?.plan.files).toContain("test/empty.test.ts")
  expect(result.reports?.inventory.files).toContainEqual({ file: "test/empty.test.ts", tests: 0 })
  expect(result.reports?.inventory.empty).toEqual([
    { file: "test/empty.test.ts", tests: 0, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
  ])
})

test("a real module registration error fails even if JUnit omits the error", async () => {
  const result = await run({ loadError: true })
  expect(result.exit).toBe(1)
  expect(result.executed).toEqual(["footer"])
  expect(result.reports?.results.map((group: { code: number }) => group.code)).toEqual([1, 0])
  expect(result.reports?.inventoryLog).toContain("Unhandled error between tests")
})

test("different test directories do not share process state", async () => {
  const result = await run({ domains: true })
  if (result.exit) console.error(result.output)
  expect(result.exit).toBe(0)
  expect(new Set(result.executed)).toEqual(new Set(["producer", "consumer", "rest", "footer"]))
  expect(result.reports?.results.every((group: { code: number }) => group.code === 0)).toBe(true)
})

test("scrollback renderer runs alone without losing other discovered files", async () => {
  const result = await run({ domains: true, scrollback: 0 })
  expect(result.exit).toBe(0)
  expect(result.executed).toEqual(["producer", "consumer", "rest", "scrollback", "footer"])
  expect(result.reports?.plan.groups).toEqual([
    { name: "package", files: ["test/alpha/producer.test.ts"] },
    { name: "package-2", files: ["test/beta/consumer.test.ts"] },
    { name: "package-3", files: ["test/rest.test.ts"] },
    { name: "scrollback", files: ["test/cli/run/scrollback.surface.test.ts"] },
    { name: "footer", files: ["test/cli/run/footer.view.test.tsx"] },
  ])
  expect(result.reports?.results.map((group: { code: number }) => group.code)).toEqual([0, 0, 0, 0, 0])
})

test("missing scrollback results stay a hard failure and still run the footer", async () => {
  const result = await run({ scrollback: 23 })
  expect(result.exit).toBe(1)
  expect(result.executed).toEqual(["rest", "scrollback", "footer"])
  expect(result.reports?.plan.groups).toEqual([
    { name: "package", files: ["test/rest.test.ts"] },
    { name: "scrollback", files: ["test/cli/run/scrollback.surface.test.ts"] },
    { name: "footer", files: ["test/cli/run/footer.view.test.tsx"] },
  ])
  expect(result.reports?.results.map((group: { code: number }) => group.code)).toEqual([0, 1, 0])
  expect(result.output).toContain("test:scrollback exit=23 result=1 files=missing/1 tests=missing/1")
})
