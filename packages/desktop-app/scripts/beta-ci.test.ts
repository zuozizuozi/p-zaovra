import { expect, test } from "bun:test"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { assessBetaCI, verifyBetaCI, verifyBetaPublish } from "./beta-ci"

const sha = "a".repeat(40)
const scrollback = "test/cli/run/scrollback.surface.test.ts"
const root = process.env.ZAOVRA_BETA_TEST_DIR
if (!root) throw new Error("Use an isolated ZAOVRA_BETA_TEST_DIR")
const run = (name: string, conclusion = "success") => ({
  id: name === "test" ? 10 : 20,
  name,
  head_sha: sha,
  head_branch: "main",
  event: "push",
  repository: { full_name: "zuozizuozi/p-zaovra" },
  run_number: 5,
  run_attempt: 2,
  status: "completed",
  conclusion,
})
function fixture() {
  const normal = "test/config/config.test.ts"
  const healthy = {
    name: "package",
    exit: 0,
    signal: null,
    code: 0,
    tests: 2,
    stats: {
      expectedFiles: 1,
      files: 1,
      expectedTests: 2,
      tests: 2,
      skipped: 0,
      failures: 0,
      assertions: 3,
      emptyFiles: 0,
    },
  }
  return {
    inventory: { workflow_runs: [run("test", "failure"), run("typecheck")] },
    evidence: {
      attempt: {
        ...run("test", "failure"),
        path: ".github/workflows/test.yml",
        head_repository: { full_name: "zuozizuozi/p-zaovra" },
      },
      jobs: {
        total_count: 1,
        jobs: [
          {
            run_id: 10,
            head_sha: sha,
            name: "unit",
            status: "completed",
            conclusion: "failure",
            started_at: "2026-11-04T09:20:00Z",
            completed_at: "2026-11-04T09:34:00Z",
            steps: [
              "Checkout repository",
              "Setup Bun",
              "Configure git identity",
              "Install browser test runtime",
              "Allow the test Chromium sandbox on Ubuntu",
              "Preserve ZA test inventories and results",
            ]
              .map((name) => ({ name, status: "completed", conclusion: "success" }))
              .concat([{ name: "Run package unit tests", status: "completed", conclusion: "failure" }]),
          },
        ],
      },
      artifact: {
        id: 30,
        name: "zaovra-test-reports",
        expired: false,
        size_in_bytes: 1000,
        digest: "sha256:" + "b".repeat(64),
        created_at: "2026-11-04T09:33:30Z",
        workflow_run: { id: 10, head_sha: sha, head_branch: "main" },
      },
      expectedFiles: [normal, scrollback],
      report: {
        plan: {
          files: [normal, scrollback],
          groups: [
            { name: "package", files: [normal] },
            { name: "scrollback", files: [scrollback] },
          ],
        },
        results: [healthy, { name: "scrollback", exit: 132, signal: "SIGILL", code: 1 }],
        files: [
          "plan.json",
          "results.json",
          "package.xml",
          "package-manifest.json",
          "package-inventory.xml",
          "scrollback-manifest.json",
          "scrollback-inventory.xml",
        ],
        scrollbackManifest: { files: [{ file: scrollback, tests: 17 }], tests: 17 },
      },
    },
  }
}
function allowed(value = fixture()) {
  return assessBetaCI(value.inventory, sha, 99, value.evidence, true)
}
test("604 only the complete scrollback SIGILL gap can release a build with run/attempt provenance", () => {
  expect(allowed()).toMatchObject({
    alreadyBuilt: false,
    k63Applied: true,
    testRun: 10,
    testAttempt: 2,
    missingTests: 17,
  })
})
test("604 another group failure remains blocking", () => {
  const value = fixture()
  value.evidence.report.results[0].exit = 1
  value.evidence.report.results[0].code = 1
  expect(() => allowed(value)).toThrow()
})
test("604 non132, nonSIGILL, incomplete inventory and present XML are never K63", () => {
  for (const mutation of ["exit", "signal", "reason", "xml", "stats"]) {
    const value = fixture()
    const result = value.evidence.report.results[1] as Record<string, unknown>
    if (mutation === "exit") result.exit = 1
    if (mutation === "signal") result.signal = "SIGSEGV"
    if (mutation === "reason") result.reason = "incomplete inventory"
    if (mutation === "stats") result.stats = { failures: 1, files: 0 }
    if (mutation === "xml") value.evidence.report.files.push("scrollback.xml")
    expect(() => allowed(value), mutation).toThrow()
  }
})
test("604 any assertion failure is blocking even with code0 and matching case counts", () => {
  const value = fixture()
  value.evidence.report.results[0].stats!.failures = 1
  expect(() => allowed(value)).toThrow()
})
test("604 typecheck failure or pending latest result cannot use the exception", () => {
  for (const conclusion of ["failure", "cancelled", "in_progress"]) {
    const value = fixture()
    value.inventory.workflow_runs[1].conclusion = conclusion
    expect(() => allowed(value)).toThrow()
  }
})
test("604 missing, duplicate, partial or unexpected planned groups and files fail closed", () => {
  for (const mutation of ["result", "plan", "duplicate", "source", "stats", "file", "empty"]) {
    const value = fixture()
    if (mutation === "result") value.evidence.report.results.pop()
    if (mutation === "plan") value.evidence.report.plan.groups.pop()
    if (mutation === "duplicate") value.evidence.report.results.push(value.evidence.report.results[0])
    if (mutation === "source") value.evidence.expectedFiles.push("test/forgotten.test.ts")
    if (mutation === "stats") value.evidence.report.results[0].stats!.tests = 1
    if (mutation === "file")
      value.evidence.report.files = value.evidence.report.files.filter((name) => name !== "package.xml")
    if (mutation === "empty") value.evidence.report.plan.groups[0].files = []
    expect(() => allowed(value), mutation).toThrow()
  }
})
test("604 mismatched attempt, stale artifact, other job or failed preparation remains blocking", () => {
  for (const mutation of ["attempt", "artifact", "job", "step", "digest", "head"]) {
    const value = fixture()
    if (mutation === "attempt") value.evidence.attempt.run_attempt = 1
    if (mutation === "artifact") value.evidence.artifact.created_at = "2026-11-04T09:00:00Z"
    if (mutation === "job") value.evidence.jobs.total_count = 2
    if (mutation === "step") value.evidence.jobs.jobs[0].steps[0].conclusion = "failure"
    if (mutation === "digest") value.evidence.artifact.digest = ""
    if (mutation === "head") value.evidence.artifact.workflow_run.head_sha = "c".repeat(40)
    expect(() => allowed(value), mutation).toThrow()
  }
})
test("604 default strict gate still requires explicit verified evidence and ordinary green CI stays valid", () => {
  const value = fixture()
  expect(() => assessBetaCI(value.inventory, sha, 99, value.evidence, false)).toThrow()
  expect(() => verifyBetaCI(value.inventory, sha)).toThrow()
  value.inventory.workflow_runs[0].conclusion = "success"
  expect(assessBetaCI(value.inventory, sha)).toMatchObject({ k63Applied: false, missingTests: 0 })
})
test("604 latest failing attempt cannot borrow the earlier passing attempt", () => {
  const value = fixture()
  value.inventory.workflow_runs.push({ ...run("test"), run_attempt: 1 })
  expect(() => verifyBetaCI(value.inventory, sha)).toThrow()
  value.evidence.attempt.run_attempt = 1
  expect(() => allowed(value)).toThrow()
})
async function archive(entries: [string, string][]) {
  const child = Bun.spawn(
    [
      process.env.PYTHON ?? "python3",
      "-c",
      "import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED); [z.writestr(k,v) for k,v in json.load(sys.stdin)]; z.close(); sys.stdout.buffer.write(b.getvalue())",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  child.stdin.write(JSON.stringify(entries))
  child.stdin.end()
  const [body, error, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, error).toBe(0)
  const directory = join(root!, crypto.randomUUID())
  await mkdir(directory, { recursive: true })
  await Bun.write(join(directory, "report.zip"), body)
  const reader = Bun.spawn([process.env.PYTHON ?? "python3", join(import.meta.dir, "beta-ci-report.py")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  reader.stdin.write(body)
  reader.stdin.end()
  const [output, stderr, exit] = await Promise.all([
    new Response(reader.stdout).text(),
    new Response(reader.stderr).text(),
    reader.exited,
  ])
  return { output, stderr, exit }
}
test("604 real bounded ZIP reader consumes structured JSON without extraction and rejects ambiguity/traversal", async () => {
  const value = fixture()
  const prefix = "zaovra-tests-11111111-1111-1111-1111-111111111111/"
  const entries: [string, string][] = [
    [prefix + "plan.json", JSON.stringify(value.evidence.report.plan)],
    [prefix + "results.json", JSON.stringify(value.evidence.report.results)],
    [prefix + "scrollback-manifest.json", JSON.stringify(value.evidence.report.scrollbackManifest)],
    ...value.evidence.report.files
      .filter((file) => !["plan.json", "results.json", "scrollback-manifest.json"].includes(file))
      .map((file): [string, string] => [prefix + file, "synthetic inventory"]),
  ]
  const valid = await archive(entries)
  expect(valid.exit, valid.stderr).toBe(0)
  const report = JSON.parse(valid.output)
  expect(allowed({ ...value, evidence: { ...value.evidence, report } }).k63Applied).toBe(true)
  for (const bad of [
    [...entries, ["../outside.txt", "no"] as [string, string]],
    [...entries, entries[0]],
    entries.map(([name, body]): [string, string] => [
      name,
      name.endsWith("plan.json") ? '{"files":[],"files":[]}' : body,
    ]),
  ])
    expect((await archive(bad)).exit).not.toBe(0)
})
test("604 workflow keeps the manual protected publish gate distinct from build-only dispatch and records provenance", async () => {
  const source = await Bun.file(join(import.meta.dir, "../../../.github/workflows/windows-beta.yml")).text()
  const workflow = Bun.YAML.parse(source) as {
    on: { workflow_dispatch: { inputs: { build_only: { default: boolean } } } }
    jobs: Record<
      string,
      { if: string; environment?: string; outputs?: Record<string, string>; steps: Record<string, unknown>[] }
    >
  }
  expect(workflow.on.workflow_dispatch.inputs.build_only.default).toBe(false)
  expect(workflow.jobs.publish.if).toBe("github.event_name == 'workflow_dispatch' && !inputs.build_only")
  expect(workflow.jobs.publish.environment).toBe("beta-publish")
  expect(workflow.jobs.build.if).toContain("inputs.build_only")
  expect(workflow.jobs.gate.outputs).toHaveProperty("test_run_attempt")
  expect(source).toContain("K63 例外已应用")
  expect(source).toContain("packages/desktop-app/dist/ci-gate.json")
  expect(source).toContain("prevent_self_review")
  expect(source).toContain("beta.yml")
})

test("604 CLI writes separate provenance output lines without network calls for green build-only CI", async () => {
  const directory = join(root!, crypto.randomUUID())
  await mkdir(directory, { recursive: true })
  const inventory = join(directory, "ci.json")
  const output = join(directory, "outputs")
  await Bun.write(inventory, JSON.stringify({ workflow_runs: [run("test"), run("typecheck")] }))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "beta-ci.ts"), inventory, sha, "99"], {
    env: {
      ...process.env,
      EVENT_NAME: "workflow_dispatch",
      BUILD_ONLY: "true",
      WORKFLOW_SHA: sha,
      GITHUB_OUTPUT: output,
      GH_TOKEN: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [body, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, error).toBe(0)
  expect(JSON.parse(body)).toMatchObject({ source: sha, k63ExceptionApplied: false, testRun: 10, testAttempt: 2 })
  expect(await Bun.file(output).text()).toBe(
    "build=true\nk63_applied=false\ntest_run_id=10\ntest_run_attempt=2\nk63_missing_tests=0\n",
  )
})

function artifactGate() {
  return { commit: sha, k63ExceptionApplied: true, testRun: "10", testAttempt: "2", missingTests: "17" }
}
test("605 publish accepts K63 only after executing the same fresh verification", () => {
  const value = fixture()
  expect(verifyBetaPublish(value.inventory, sha, 99, artifactGate(), value.evidence)).toMatchObject({
    k63Applied: true,
    testRun: 10,
    testAttempt: 2,
    missingTests: 17,
  })
  expect(() => verifyBetaPublish(value.inventory, sha, 99, artifactGate())).toThrow()
})
test("605 valid-looking ci-gate cannot conceal a non-K63 failure or assertion failure", () => {
  for (const field of ["exit", "assertion", "type"]) {
    const value = fixture()
    if (field === "exit") value.evidence.report.results[1].exit = 1
    if (field === "assertion") value.evidence.report.results[0].stats!.failures = 1
    if (field === "type") value.inventory.workflow_runs[1].conclusion = "failure"
    expect(() => verifyBetaPublish(value.inventory, sha, 99, artifactGate(), value.evidence), field).toThrow()
  }
})
test("605 any difference between reviewed ci-gate and fresh decision refuses publish", () => {
  for (const [field, mismatch] of [
    ["commit", "c".repeat(40)],
    ["k63ExceptionApplied", false],
    ["k63ExceptionApplied", "true"],
    ["testRun", "11"],
    ["testAttempt", "1"],
    ["missingTests", "0"],
  ]) {
    const value = fixture()
    const gate: Record<string, unknown> = artifactGate()
    gate[String(field)] = mismatch
    expect(() => verifyBetaPublish(value.inventory, sha, 99, gate, value.evidence), String(field)).toThrow()
  }
})
test("605 changed latest attempt or a newly pending attempt cannot borrow the reviewed build decision", () => {
  const value = fixture()
  value.inventory.workflow_runs[0].run_attempt = 3
  value.evidence.attempt.run_attempt = 3
  expect(() => verifyBetaPublish(value.inventory, sha, 99, artifactGate(), value.evidence)).toThrow("differs")
  value.inventory.workflow_runs[0].status = "in_progress"
  expect(() => verifyBetaPublish(value.inventory, sha, 99, artifactGate(), value.evidence)).toThrow()
})
test("605 green publish also requires matching artifact provenance, never a stale K63 flag", () => {
  const value = fixture()
  value.inventory.workflow_runs[0].conclusion = "success"
  expect(() => verifyBetaPublish(value.inventory, sha, 99, artifactGate())).toThrow()
  const gate = { ...artifactGate(), k63ExceptionApplied: false, missingTests: "0" }
  expect(verifyBetaPublish(value.inventory, sha, 99, gate)).toMatchObject({ k63Applied: false })
  expect(() => verifyBetaPublish(value.inventory, sha, 99, {})).toThrow()
})
test("605 real publish CLI compares downloaded ci-gate before returning success", async () => {
  const directory = join(root!, crypto.randomUUID())
  await mkdir(directory, { recursive: true })
  const inventory = join(directory, "ci.json")
  const metadata = join(directory, "ci-gate.json")
  await Bun.write(inventory, JSON.stringify({ workflow_runs: [run("test"), run("typecheck")] }))
  const execute = async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "beta-ci.ts"), inventory, sha, "99", metadata], {
      env: { ...process.env, EVENT_NAME: "publish", BUILD_ONLY: "false", GH_TOKEN: "" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { output, error, code }
  }
  await Bun.write(metadata, JSON.stringify({ ...artifactGate(), k63ExceptionApplied: false, missingTests: "0" }))
  const matching = await execute()
  expect(matching.code, matching.error).toBe(0)
  expect(JSON.parse(matching.output)).toMatchObject({ testRun: 10, testAttempt: 2, k63ExceptionApplied: false })
  await Bun.write(
    metadata,
    JSON.stringify({ ...artifactGate(), k63ExceptionApplied: false, missingTests: "0", testAttempt: "1" }),
  )
  const mismatch = await execute()
  expect(mismatch.code).not.toBe(0)
  expect(mismatch.error).toContain("differs from the fresh publish verification")
})
test("605 fresh K63 comparison occurs inside the approved publish job after artifact download", async () => {
  const source = await Bun.file(join(import.meta.dir, "../../../.github/workflows/windows-beta.yml")).text()
  const workflow = Bun.YAML.parse(source) as {
    jobs: Record<
      string,
      {
        if: string
        environment?: string
        steps: { name?: string; env?: Record<string, string>; run?: string; uses?: string }[]
      }
    >
  }
  const publish = workflow.jobs.publish
  const fresh = publish.steps.findIndex(
    (step) => step.name === "Reverify latest exact CI and compare reviewed artifact gate",
  )
  const download = publish.steps.findIndex((step) => step.uses?.startsWith("actions/download-artifact@"))
  const upload = publish.steps.findIndex((step) => step.name === "Publish approved exact SHA and retain five versions")
  expect(publish.environment).toBe("beta-publish")
  expect(publish.if).toBe("github.event_name == 'workflow_dispatch' && !inputs.build_only")
  expect(fresh).toBeGreaterThan(download)
  expect(fresh).toBeLessThan(upload)
  expect(publish.steps[fresh].env).toMatchObject({ EVENT_NAME: "publish", PYTHON: "python" })
  expect(publish.steps[fresh].env).not.toHaveProperty("R2_ACCESS_KEY_ID")
  expect(publish.steps[fresh].run).toContain("actions/runs?head_sha=$sha&per_page=100")
  expect(publish.steps[fresh].run).toContain("beta-artifact/ci-gate.json")
  expect(publish.steps[fresh].run).toContain("$LASTEXITCODE")
})
