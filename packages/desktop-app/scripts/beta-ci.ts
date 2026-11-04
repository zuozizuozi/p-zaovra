import { appendFile } from "node:fs/promises"
import { join } from "node:path"

type Run = {
  id?: number
  name?: string
  head_sha?: string
  head_branch?: string
  event?: string
  repository?: { full_name?: string }
  run_number: number
  run_attempt: number
  status?: string
  conclusion?: string
}
type Evidence = { attempt: unknown; jobs: unknown; artifact: unknown; report: unknown; expectedFiles: string[] }
const repository = "zuozizuozi/p-zaovra"
const scrollback = "test/cli/run/scrollback.surface.test.ts"

export function verifyBetaCI(input: unknown, sha: string, currentRun?: number) {
  return assessBetaCI(input, sha, currentRun).alreadyBuilt
}

export function assessBetaCI(input: unknown, sha: string, currentRun?: number, evidence?: Evidence, allowK63 = false) {
  const ci = selectCI(input, sha)
  if (ci.typecheck.status !== "completed" || ci.typecheck.conclusion !== "success")
    throw new Error("Exact main typecheck CI has not passed")
  if (ci.test.status !== "completed" || !["success", "failure"].includes(ci.test.conclusion ?? ""))
    throw new Error("Exact main test CI has not completed")
  const k63 = ci.test.conclusion === "failure"
  if (k63 && (!allowK63 || !evidence)) throw new Error("Exact main test CI has not passed")
  const missingTests = k63 ? verifyK63(evidence!, sha, ci.test) : 0
  return {
    alreadyBuilt: ci.runs.some(
      (run) =>
        run.name === "windows-beta" &&
        ["workflow_run", "workflow_dispatch"].includes(run.event ?? "") &&
        run.head_sha === sha &&
        run.repository?.full_name === repository &&
        run.id !== currentRun &&
        run.status === "completed" &&
        run.conclusion === "success",
    ),
    k63Applied: k63,
    testRun: ci.test.id ?? 0,
    testAttempt: ci.test.run_attempt,
    missingTests,
  }
}

function selectCI(input: unknown, sha: string) {
  const inventory = record(input)
  if (!/^[a-f0-9]{40}$/.test(sha) || !Array.isArray(inventory.workflow_runs)) throw new Error("Invalid CI inventory")
  if (inventory.total_count !== undefined && inventory.total_count !== inventory.workflow_runs.length)
    throw new Error("Incomplete CI inventory")
  const runs = inventory.workflow_runs as Run[]
  const latest = (name: string) => {
    const run = runs
      .filter(
        (run) =>
          run.name === name &&
          run.head_sha === sha &&
          run.head_branch === "main" &&
          run.event === "push" &&
          run.repository?.full_name === repository,
      )
      .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0]
    if (!run || !Number.isSafeInteger(run.run_number) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1)
      throw new Error("Missing exact main " + name + " CI")
    return run
  }
  return { runs, test: latest("test"), typecheck: latest("typecheck") }
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid structured CI evidence")
  return input as Record<string, unknown>
}

function count(input: unknown) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) throw new Error("Invalid result count")
  return input
}

function strings(input: unknown) {
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string") || new Set(input).size !== input.length)
    throw new Error("Invalid file inventory")
  return input as string[]
}

function same(a: string[], b: string[]) {
  return JSON.stringify(a.toSorted()) === JSON.stringify(b.toSorted())
}

function unitAttempt(input: unknown, jobsInput: unknown, sha: string, test: Run) {
  const attempt = record(input)
  if (
    !test.id ||
    attempt.id !== test.id ||
    attempt.run_attempt !== test.run_attempt ||
    attempt.head_sha !== sha ||
    attempt.head_branch !== "main" ||
    attempt.event !== "push" ||
    attempt.name !== "test" ||
    attempt.path !== ".github/workflows/test.yml" ||
    record(attempt.repository).full_name !== repository ||
    record(attempt.head_repository).full_name !== repository ||
    attempt.status !== "completed" ||
    attempt.conclusion !== "failure"
  )
    throw new Error("Test attempt identity mismatch")
  const jobs = record(jobsInput)
  if (!Array.isArray(jobs.jobs) || jobs.total_count !== 1 || jobs.jobs.length !== 1)
    throw new Error("Incomplete test jobs")
  const job = record(jobs.jobs[0])
  if (
    job.run_id !== test.id ||
    job.head_sha !== sha ||
    job.name !== "unit" ||
    job.status !== "completed" ||
    job.conclusion !== "failure" ||
    !Array.isArray(job.steps)
  )
    throw new Error("Test unit job mismatch")
  const steps = job.steps.map(record)
  const failed = steps.filter((step) => step.conclusion !== "success" && step.conclusion !== "skipped")
  if (
    failed.length !== 1 ||
    failed[0].name !== "Run package unit tests" ||
    failed[0].conclusion !== "failure" ||
    steps.some((step) => step.status !== "completed")
  )
    throw new Error("Other test job failure")
  for (const name of [
    "Checkout repository",
    "Setup Bun",
    "Configure git identity",
    "Install browser test runtime",
    "Allow the test Chromium sandbox on Ubuntu",
    "Preserve ZA test inventories and results",
  ])
    if (steps.filter((step) => step.name === name && step.conclusion === "success").length !== 1)
      throw new Error("Missing successful test preparation or artifact step")
  if (
    !Number.isFinite(Date.parse(String(job.started_at))) ||
    !Number.isFinite(Date.parse(String(job.completed_at))) ||
    Date.parse(String(job.completed_at)) < Date.parse(String(job.started_at))
  )
    throw new Error("Invalid attempt timestamps")
  return job
}

function artifactIdentity(input: unknown, job: Record<string, unknown>, sha: string, test: Run) {
  const artifact = record(input)
  const source = record(artifact.workflow_run)
  const created = Date.parse(String(artifact.created_at))
  if (
    !count(artifact.id) ||
    artifact.name !== "zaovra-test-reports" ||
    artifact.expired !== false ||
    source.id !== test.id ||
    source.head_sha !== sha ||
    source.head_branch !== "main" ||
    !Number.isFinite(created) ||
    created < Date.parse(String(job.started_at)) ||
    created > Date.parse(String(job.completed_at)) ||
    !count(artifact.size_in_bytes) ||
    count(artifact.size_in_bytes) > 8 * 1024 * 1024 ||
    typeof artifact.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
  )
    throw new Error("Artifact does not belong to the exact attempt")
  return artifact
}

export function verifyK63(evidence: Evidence, sha: string, test: Run) {
  const job = unitAttempt(evidence.attempt, evidence.jobs, sha, test)
  artifactIdentity(evidence.artifact, job, sha, test)
  const report = record(evidence.report)
  const plan = record(report.plan)
  const expected = strings(evidence.expectedFiles)
  if (
    !expected.length ||
    !same(strings(plan.files), expected) ||
    !Array.isArray(plan.groups) ||
    !plan.groups.length ||
    !Array.isArray(report.results) ||
    report.results.length !== plan.groups.length
  )
    throw new Error("Missing planned groups or source files")
  const groups = plan.groups.map(record)
  const names = strings(groups.map((group) => group.name))
  const covered = groups.flatMap((group) => {
    const files = strings(group.files)
    if (!files.length) throw new Error("Empty planned group")
    return files
  })
  if (!same(strings(covered), expected)) throw new Error("Incomplete plan coverage")
  const results = report.results.map(record)
  if (!same(strings(results.map((result) => result.name)), names)) throw new Error("Missing result group")
  const files = strings(report.files)
  const manifest = record(report.scrollbackManifest)
  if (
    !files.includes("scrollback-manifest.json") ||
    !files.includes("scrollback-inventory.xml") ||
    files.includes("scrollback.xml") ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 1 ||
    record(manifest.files[0]).file !== scrollback ||
    count(record(manifest.files[0]).tests) !== count(manifest.tests) ||
    !count(manifest.tests)
  )
    throw new Error("K63 requires a complete inventory and missing actual XML")
  for (const group of groups) {
    const result = results.find((result) => result.name === group.name)!
    if (group.name === "scrollback") {
      if (
        !same(strings(group.files), [scrollback]) ||
        result.exit !== 132 ||
        result.signal !== "SIGILL" ||
        result.code !== 1 ||
        result.stats !== undefined ||
        result.tests !== undefined ||
        result.reason !== undefined
      )
        throw new Error("Not the narrow scrollback K63 signature")
      continue
    }
    if (
      ![group.name + ".xml", group.name + "-manifest.json", group.name + "-inventory.xml"].every((name) =>
        files.includes(name),
      )
    )
      throw new Error("Missing healthy group reports")
    const stats = record(result.stats)
    if (
      result.exit !== 0 ||
      result.signal !== null ||
      result.code !== 0 ||
      result.reason !== undefined ||
      count(stats.failures) !== 0 ||
      count(stats.expectedFiles) !== strings(group.files).length ||
      count(stats.files) !== count(stats.expectedFiles) ||
      count(stats.tests) !== count(stats.expectedTests) ||
      count(result.tests) !== count(stats.tests) ||
      count(stats.skipped) > count(stats.tests) ||
      count(stats.emptyFiles) > count(stats.files)
    )
      throw new Error("Other group failed or incomplete")
    count(stats.assertions)
  }
  if (names.filter((name) => name === "scrollback").length !== 1) throw new Error("Missing scrollback group")
  return count(manifest.tests)
}

async function github(path: string) {
  const child = Bun.spawn(["gh", "api", "repos/" + repository + "/actions/" + path], { stdout: "pipe", stderr: "pipe" })
  const [body, , exit] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit !== 0) throw new Error("GitHub CI evidence read failed")
  return new Uint8Array(body)
}

async function loadEvidence(test: Run, sha: string): Promise<Evidence> {
  const attempt = JSON.parse(
    new TextDecoder().decode(await github("runs/" + test.id + "/attempts/" + test.run_attempt)),
  ) as unknown
  const jobs = JSON.parse(
    new TextDecoder().decode(await github("runs/" + test.id + "/attempts/" + test.run_attempt + "/jobs?per_page=100")),
  ) as unknown
  const job = unitAttempt(attempt, jobs, sha, test)
  const inventory = record(
    JSON.parse(new TextDecoder().decode(await github("runs/" + test.id + "/artifacts?per_page=100"))),
  )
  if (!Array.isArray(inventory.artifacts) || inventory.total_count !== inventory.artifacts.length)
    throw new Error("Incomplete artifact inventory")
  const candidates = inventory.artifacts
    .map(record)
    .filter(
      (artifact) =>
        artifact.name === "zaovra-test-reports" &&
        Date.parse(String(artifact.created_at)) >= Date.parse(String(job.started_at)) &&
        Date.parse(String(artifact.created_at)) <= Date.parse(String(job.completed_at)),
    )
  if (candidates.length !== 1) throw new Error("Missing or ambiguous attempt artifact")
  const artifact = artifactIdentity(candidates[0], job, sha, test)
  const zip = await github("artifacts/" + artifact.id + "/zip")
  if (
    zip.length !== artifact.size_in_bytes ||
    "sha256:" + new Bun.CryptoHasher("sha256").update(zip).digest("hex") !== artifact.digest
  )
    throw new Error("Artifact archive integrity mismatch")
  const reader = Bun.spawn([process.env.PYTHON ?? "python3", join(import.meta.dir, "beta-ci-report.py")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  reader.stdin.write(zip)
  reader.stdin.end()
  const [body, , exit] = await Promise.all([
    new Response(reader.stdout).text(),
    new Response(reader.stderr).text(),
    reader.exited,
  ])
  if (exit !== 0) throw new Error("Invalid CI report archive")
  const cwd = join(import.meta.dir, "../../zaovra")
  const expectedFiles = Array.from(
    new Bun.Glob("**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}").scanSync({ cwd, onlyFiles: true }),
  )
    .filter((file) => !file.split(/[\\/]/).some((part) => part === "node_modules" || part === ".git"))
    .map((file) => file.replaceAll("\\", "/"))
  return { attempt, jobs, artifact, report: JSON.parse(body) as unknown, expectedFiles }
}

if (import.meta.main) {
  const sha = process.argv[3]
  const buildOnly = process.env.EVENT_NAME === "workflow_run" || process.env.BUILD_ONLY === "true"
  if (buildOnly && process.env.WORKFLOW_SHA !== sha) throw new Error("The build must use the workflow source SHA")
  const input: unknown = await Bun.file(process.argv[2]).json()
  const selected = selectCI(input, sha)
  if (!count(selected.test.id)) throw new Error("Missing exact test run identity")
  if (selected.typecheck.status !== "completed" || selected.typecheck.conclusion !== "success")
    throw new Error("Exact main typecheck CI has not passed")
  const evidence =
    buildOnly && selected.test.status === "completed" && selected.test.conclusion === "failure"
      ? await loadEvidence(selected.test, sha)
      : undefined
  const decision = assessBetaCI(input, sha, Number(process.argv[4]), evidence, buildOnly)
  const metadata = {
    source: sha,
    k63ExceptionApplied: decision.k63Applied,
    message: decision.k63Applied ? "K63 例外已应用" : "Exact main test and typecheck passed",
    testRun: decision.testRun,
    testAttempt: decision.testAttempt,
    missingTests: decision.missingTests,
  }
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      "build=" +
        !decision.alreadyBuilt +
        "\n" +
        "k63_applied=" +
        decision.k63Applied +
        "\n" +
        "test_run_id=" +
        decision.testRun +
        "\n" +
        "test_run_attempt=" +
        decision.testAttempt +
        "\n" +
        "k63_missing_tests=" +
        decision.missingTests +
        "\n",
    )
  console.log(JSON.stringify(metadata))
}
