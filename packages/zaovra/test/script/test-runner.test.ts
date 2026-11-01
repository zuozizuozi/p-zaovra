import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

async function run(input: { rest?: number; footer?: number; args?: string[] }) {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "script/test.ts"), Bun.file(new URL("../../script/test.ts", import.meta.url)))
  const fixture = (name: string, exit = 0) => `
import { test } from "bun:test"
import { appendFileSync } from "node:fs"
test(${JSON.stringify(name)}, () => {
  appendFileSync(${JSON.stringify(path.join(tmp.path, "executed"))}, ${JSON.stringify(name + "\n")})
  if (${exit}) process.exit(${exit})
})
`
  await Bun.write(path.join(tmp.path, "test/rest.test.ts"), fixture("rest", input.rest))
  await Bun.write(path.join(tmp.path, "test/cli/run/footer.view.test.tsx"), fixture("footer", input.footer))
  const child = Bun.spawn([process.execPath, "--no-env-file", "run", "script/test.ts", ...(input.args ?? [])], {
    cwd: tmp.path,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
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
  }
}

test("default package runner executes every file once in separate groups", async () => {
  const result = await run({})
  expect(result.exit).toBe(0)
  expect(result.executed).toEqual(["rest", "footer"])
  expect(result.output).toContain("test:package exit=0")
  expect(result.output).toContain("test:footer exit=0")
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
})
