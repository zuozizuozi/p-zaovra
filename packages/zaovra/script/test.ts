import path from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { emptyModule, parseReport, reportExit } from "./test-report"

const options = ["--max-concurrency", "2", "--timeout", "30000", "--only-failures"]
const args = process.argv.slice(2)
const cwd = path.resolve(import.meta.dir, "..")
// Keep explicit focused Bun invocations intact; complete-run certification only
// applies to the default full entrypoint, not arbitrary filters or --bail.
if (args.length) {
  console.log("test:selected starting")
  const child = Bun.spawn([process.execPath, "test", ...options, ...args], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exit = await child.exited
  console.log(`test:selected exit=${exit}${child.signalCode ? ` signal=${child.signalCode}` : ""}`)
  process.exit(exit === 0 ? 0 : 1)
}

const directory = path.join(process.env.ZAOVRA_TEST_REPORT_DIR ?? tmpdir(), `zaovra-tests-${randomUUID()}`)
const files = Array.from(
  new Bun.Glob("**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}").scanSync({ cwd, onlyFiles: true }),
)
  .filter((file) => !file.split(/[\\/]/).some((part) => part === "node_modules" || part === ".git"))
  .map((file) => file.replaceAll("\\", "/"))
  .sort()
const rest = files.filter((file) => !file.endsWith("/footer.view.test.tsx"))
const footer = files.filter((file) => file.endsWith("/footer.view.test.tsx"))
// Keep test domains in separate processes and bound their lifetimes, retaining
// every discovered file exactly once without sharing domain-global state.
const batches = Array.from(
  Map.groupBy(rest, (file) => path.posix.dirname(file).split("/").slice(0, 2).join("/")).values(),
).flatMap((files) =>
  Array.from({ length: Math.ceil(files.length / 24) }, (_, index) => files.slice(index * 24, (index + 1) * 24)),
)
const groups = batches
  .map((files, index) => ({ name: index ? `package-${index + 1}` : "package", files }))
  .concat(footer.length ? [{ name: "footer", files: footer }] : [])
await Bun.write(path.join(directory, "plan.json"), JSON.stringify({ bun: Bun.version, cwd, files, groups }, null, 2))
console.log(`test:reports ${directory}`)
const results: {
  name: string
  exit: number
  signal: string | null
  code: number
  tests?: number
  reason?: string
  stats?: {
    expectedFiles: number
    files: number
    expectedTests: number
    tests: number
    skipped: number
    failures: number
    assertions: number
    emptyFiles: number
  }
}[] = []
for (const group of groups) {
  const base = path.join(directory, group.name)
  const selected = group.files.map((file) => `./${file}`)
  console.log(`test:${group.name} inventory files=${group.files.length}`)
  const inventory = Bun.spawn(
    [
      process.execPath,
      "test",
      ...options,
      ...selected,
      "--test-name-pattern",
      "a^",
      "--reporter=junit",
      `--reporter-outfile=${base}-inventory.xml`,
    ],
    { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [inventoryExit, stdout, stderr] = await Promise.all([
    inventory.exited,
    new Response(inventory.stdout).text(),
    new Response(inventory.stderr).text(),
  ])
  await Bun.write(`${base}-inventory.log`, stdout + stderr)
  const expected = await Bun.file(`${base}-inventory.xml`)
    .text()
    .then(parseReport)
    .catch(() => undefined)
  const missing = expected ? group.files.filter((file) => !expected.files.some((entry) => entry.file === file)) : []
  const empty = await Promise.all(
    missing.map(async (file) => {
      const bytes = await Bun.file(path.join(cwd, file)).arrayBuffer()
      if (!emptyModule(new TextDecoder().decode(bytes))) return
      return { file, tests: 0, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") }
    }),
  ).catch(() => [])
  const emptyFiles = empty.flatMap((file) => (file ? [file] : []))
  expected?.files.push(...emptyFiles.map(({ file, tests }) => ({ file, tests })))
  if (
    !expected ||
    inventory.signalCode ||
    inventoryExit !== 1 ||
    !stderr.includes('regex "a^" matched 0 tests') ||
    (stdout + stderr).includes("Unhandled error between tests") ||
    expected.failures ||
    expected.skipped !== expected.tests ||
    emptyFiles.length !== missing.length ||
    JSON.stringify(expected.files.map((file) => file.file).sort()) !== JSON.stringify(group.files)
  ) {
    results.push({
      name: group.name,
      exit: inventoryExit,
      signal: inventory.signalCode,
      code: 1,
      reason: "incomplete inventory",
    })
    await Bun.write(path.join(directory, "results.json"), JSON.stringify(results, null, 2))
    console.error(`test:${group.name} incomplete inventory; failed`)
    continue
  }
  await Bun.write(
    `${base}-manifest.json`,
    JSON.stringify({ files: expected.files, tests: expected.tests, empty: emptyFiles }, null, 2),
  )
  console.log(`test:${group.name} starting files=${group.files.length} tests=${expected.tests}`)
  const child = Bun.spawn(
    [process.execPath, "test", ...options, ...selected, "--reporter=junit", `--reporter-outfile=${base}.xml`],
    { cwd, stdin: "inherit", stdout: "pipe", stderr: "pipe" },
  )
  const [exit, stdoutUnhandled, stderrUnhandled] = await Promise.all([
    child.exited,
    capture(child.stdout, `${base}.stdout.log`, Bun.stdout),
    capture(child.stderr, `${base}.stderr.log`, Bun.stderr),
  ])
  const actual = await Bun.file(`${base}.xml`)
    .text()
    .then(parseReport)
    .catch(() => undefined)
  const unchangedEmpty = await Promise.all(
    emptyFiles.map(
      async (file) =>
        new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(cwd, file.file)).arrayBuffer()).digest("hex") ===
        file.sha256,
    ),
  ).catch(() => [false])
  if (actual && unchangedEmpty.every(Boolean))
    actual.files.push(
      ...emptyFiles
        .filter((file) => !actual.files.some((entry) => entry.file === file.file))
        .map(({ file, tests }) => ({ file, tests })),
    )
  const code =
    actual && unchangedEmpty.every(Boolean)
      ? reportExit({ expected, actual, exit, signal: child.signalCode, unhandled: stdoutUnhandled || stderrUnhandled })
      : 1
  results.push({
    name: group.name,
    exit,
    signal: child.signalCode,
    code,
    tests: actual?.tests,
    stats: actual
      ? {
          expectedFiles: expected.files.length,
          files: actual.files.length,
          expectedTests: expected.tests,
          tests: actual.tests,
          skipped: actual.skipped,
          failures: actual.failures,
          assertions: actual.assertions,
          emptyFiles: emptyFiles.length,
        }
      : undefined,
  })
  await Bun.write(path.join(directory, "results.json"), JSON.stringify(results, null, 2))
  console.log(
    `test:${group.name} exit=${exit}${child.signalCode ? ` signal=${child.signalCode}` : ""} result=${code} files=${actual?.files.length ?? "missing"}/${expected.files.length} tests=${actual?.tests ?? "missing"}/${expected.tests}`,
  )
  if (code === 2)
    console.error(`test:${group.name} all test results complete and passing; Bun crashed during shutdown (exit2)`)
  if (code === 1) console.error(`test:${group.name} failed or incomplete results`)
}
process.exit(
  !groups.length || results.some((result) => result.code === 1)
    ? 1
    : results.some((result) => result.code === 2)
      ? 2
      : 0,
)

async function capture(stream: ReadableStream<Uint8Array>, file: string, output: Bun.BunFile) {
  const writer = Bun.file(file).writer()
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let tail = ""
  let unhandled = false
  while (true) {
    const next = await reader.read()
    if (next.done) break
    const chunk = next.value
    writer.write(chunk)
    await writer.flush()
    await output.write(chunk)
    const text = (tail + decoder.decode(chunk, { stream: true })).replace(/\x1b\[[0-9;]*m/g, "")
    if (text.includes("Unhandled error between tests")) unhandled = true
    tail = text.slice(-256)
  }
  await writer.end()
  reader.releaseLock()
  return unhandled
}
