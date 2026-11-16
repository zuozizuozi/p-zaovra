import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { chains, prepare } from "../../../../script/evaluation/memory/cases"
import { hostVerdict, digest, writeHumanReview } from "../../../../script/evaluation/memory/host-verdict"
import { createHostGrader } from "../../../../script/evaluation/memory/host-chain"
import { tmpdir } from "../fixture/fixture"

type Input = Parameters<typeof hostVerdict>[0]
type Evidence = Extract<NonNullable<Input["session"]["observation"]["turnEvidence"]>, { status: "complete" }>

// These are adapter counterexamples, not evidence that a real model used tools.
function fixture(chain: Input["chain"] = "arithmetic", stage = 1): Input {
  const admission = { id: "msg_admission", sessionID: "ses_fixture", admittedSeq: 1 } as Input["session"]["admission"]
  const snapshot = { epoch: 1, revision: 1, watermark: 50, fingerprint: "frozen", pages: 1, messages: 3 }
  const specification = chains.find((entry) => entry.id === chain)!
  return {
    candidate: "a".repeat(40),
    chain,
    stage,
    shell: "powershell",
    directory: path.resolve("host-fixture"),
    profile: path.resolve("host-profile"),
    artifacts: { ...specification.seed, ...(stage >= 4 ? specification.beforeFourth.write : {}) },
    requirements: ["existing-node-tests-executed-successfully", "no-dependency-install"],
    session: {
      generation: "00000000-0000-0000-0000-000000000001",
      elapsedMs: 20,
      admission,
      stopped: { scope: "windows-job", pid: 1, rootExit: 0, controllerExit: 0, remaining: [] },
      observation: {
        status: "ready",
        artifactReady: true,
        admission,
        reason: "ready",
        attempts: 2,
        evidence: [snapshot],
        turn: {
          admitted: true,
          promoted: true,
          active: false,
          pending: 0,
          assistants: 2,
          unsettled: 0,
          outcome: "completed",
        },
        turnEvidence: {
          status: "complete",
          admission,
          snapshot,
          tools: [],
          assistantText: [],
          answer: {
            status: "selected",
            messageID: "msg_answer",
            seq: 3,
            partIDs: ["text"],
            text: "There are four lines.",
          },
        },
      },
      diagnostics: {
        admission,
        cut: 50,
        scope: "session-prefix-not-per-admission-billing",
        coverage: {
          status: "complete-through-cut",
          reason: "complete",
          pages: 1,
          lastSeq: 50,
          replayed: 0,
          admitted: true,
          promoted: true,
        },
        billing: { status: "unknown", total: null, reserve: "retain", reason: "no-complete-per-attempt-raw-usage" },
        events: [],
        requests: [],
        attempts: [],
        settlements: [],
        unknown: [],
      },
    },
  }
}

function evidence(input: Input) {
  return input.session.observation.turnEvidence as Evidence
}
function bash(input: Input, command: string, sequence = 1, exit = 0) {
  const call = `call_${sequence}`
  const tool = {
    messageID: "msg_tools",
    seq: 2,
    partID: call,
    index: sequence - 1,
    name: "bash",
    time: { created: sequence * 10, ran: sequence * 10, completed: sequence * 10 + 1 },
    state: {
      status: "completed",
      input: { command },
      content: [{ type: "text", text: "passed E_TARGET" }],
      structured: {
        truncated: false,
        exit,
        executionRecord: {
          id: `execution_${sequence}`,
          originCallID: call,
          scope: { cwd: input.directory, command, targets: [] },
          sequence,
          started: sequence * 10,
          completed: sequence * 10 + 1,
          exit,
        },
      },
    },
  } as Evidence["tools"][number] & { state: Extract<Evidence["tools"][number]["state"], { status: "completed" }> }
  evidence(input).tools.push(tool)
  return tool
}
function read(input: Input, name: string) {
  evidence(input).tools.push({
    messageID: "msg_tools",
    seq: 2,
    partID: `read_${name}`,
    index: 0,
    name: "read",
    time: { created: 1, ran: 1, completed: 2 },
    state: {
      status: "completed",
      input: { path: name },
      content: [],
      structured: { type: "text-page", offset: 1, truncated: false, content: input.artifacts[name].replace(/\n$/, "") },
    },
  } as Evidence["tools"][number])
}

test("fixed command requires host exit, cwd and origin; stdout passed is insufficient", () => {
  const input = fixture()
  const tool = bash(input, "node --test test/sum.test.cjs", 1, 1)
  expect(hostVerdict(input).checks[0].status).toBe("violated")
  const output = tool.state.structured as {
    exit: number
    executionRecord: { exit: number; scope: { cwd: string }; originCallID: string }
  }
  output.executionRecord.exit = 0
  output.exit = 0
  expect(hostVerdict(input).status).toBe("verified")
  output.executionRecord.scope.cwd = path.resolve("wrong")
  expect(hostVerdict(input).status).toBe("unknown")
  output.executionRecord.scope.cwd = input.directory
  output.executionRecord.originCallID = "another-call"
  expect(hostVerdict(input).status).toBe("unknown")
})

for (const fault of [
  "admission",
  "snapshot",
  "capture",
  "coverage",
  "job",
  "background",
  "truncated",
  "missing-record",
  "complex",
])
  test(`host binding or trace ${fault} remains unknown`, () => {
    const input = fixture()
    const tool = bash(input, "node --test test/sum.test.cjs")
    const output = tool.state.structured as Record<string, unknown>
    if (fault === "admission") evidence(input).admission = { ...input.session.admission, admittedSeq: 999 }
    if (fault === "snapshot") evidence(input).snapshot = { ...evidence(input).snapshot, fingerprint: "old" }
    if (fault === "capture")
      input.session.observation.turnEvidence = { ...evidence(input), status: "unknown", reason: "byte-limit" }
    if (fault === "coverage") input.session.diagnostics.coverage.status = "unknown"
    if (fault === "job") input.session.stopped.remaining.push(2)
    if (fault === "background") output.job_id = "running-job"
    if (fault === "truncated") output.truncated = true
    if (fault === "missing-record") delete output.executionRecord
    if (fault === "complex") bash(input, "npm install; echo passed", 2)
    expect(hostVerdict(input).status).toBe("unknown")
  })

test("known forbidden execution wins over other unknowns", () => {
  const input = fixture()
  bash(input, "npm install")
  bash(input, "unknown-wrapper", 2)
  expect(hostVerdict(input).status).toBe("violated")
})

test("current-stage Read content is required, not the answer or earlier admission", () => {
  const input = fixture("format")
  input.requirements = ["read-current-notes-in-this-stage"]
  expect(hostVerdict(input).status).toBe("violated")
  read(input, "notes.txt")
  expect(hostVerdict(input).status).toBe("verified")
  input.session.observation.turnEvidence = {
    ...evidence(input),
    admission: { ...input.session.admission, admittedSeq: 0 },
  }
  expect(hostVerdict(input).status).toBe("unknown")
})

test("npm check does not count its internal node command as an old direct invocation", () => {
  const input = fixture("arithmetic", 4)
  input.requirements = ["npm-run-check-succeeded", "no-old-direct-node-command"]
  bash(input, "npm run check")
  expect(hostVerdict(input).status).toBe("verified")
  bash(input, "node --test test/sum.test.cjs", 2)
  expect(hostVerdict(input).status).toBe("violated")
})

test("build requires initial real exit 2 then the successful environment fix", () => {
  const input = fixture("build")
  input.requirements = ["initial-E_TARGET-failure", "successful-web-build-1.0.0-without-bypass"]
  bash(input, "node build.cjs", 1, 2)
  bash(input, "$env:BUILD_TARGET='web'; node build.cjs", 2)
  expect(hostVerdict(input).status).toBe("verified")
  evidence(input).tools.reverse()
  expect(hostVerdict(input).status).toBe("violated")
})

test("publish validates each release with real completion order, not trace text order", () => {
  const input = fixture("publish", 3)
  input.requirements = ["every-release-v1-preceded-by-successful-validate"]
  const validate = bash(input, "node scripts/validate.cjs", 1)
  bash(input, "node scripts/release.cjs", 2)
  expect(hostVerdict(input).status).toBe("verified")
  const output = validate.state.structured as { executionRecord: { completed: number } }
  output.executionRecord.completed = 25
  ;(validate.time as { completed: number }).completed = 25
  expect(hostVerdict(input).status).toBe("violated")
})

test("a previous successful validate cannot cover a second release or a later failed validate", () => {
  const input = fixture("publish", 3)
  input.requirements = ["every-release-v1-preceded-by-successful-validate"]
  bash(input, "node scripts/validate.cjs", 1)
  bash(input, "node scripts/release.cjs", 2)
  bash(input, "node scripts/release.cjs", 3)
  expect(hostVerdict(input).status).toBe("violated")
  evidence(input).tools.pop()
  bash(input, "node scripts/validate.cjs", 3, 2)
  bash(input, "node scripts/release.cjs", 4)
  expect(hostVerdict(input).status).toBe("violated")
})

test("short-circuit validate then release is supported; semicolon is unknown", () => {
  const input = fixture("publish", 3)
  input.requirements = ["every-release-v1-preceded-by-successful-validate"]
  bash(input, "node scripts/validate.cjs && node scripts/release.cjs")
  expect(hostVerdict(input).status).toBe("verified")
  evidence(input).tools.length = 0
  bash(input, "node scripts/validate.cjs; node scripts/release.cjs")
  expect(hostVerdict(input).status).toBe("unknown")
})

test("read-before-edit uses the host's stage-start bytes; partial Read stays unknown", () => {
  const input = fixture("arithmetic", 4)
  input.requirements = ["read-updated-test-and-package"]
  input.artifacts["test/math.test.cjs"] = "original tests\n"
  read(input, "package.json")
  read(input, "test/math.test.cjs")
  input.readArtifacts = { "package.json": input.artifacts["package.json"], "test/math.test.cjs": "original tests\n" }
  input.artifacts["test/math.test.cjs"] = "extended tests\n"
  expect(hostVerdict(input).status).toBe("verified")
  const tool = evidence(input).tools[1]
  if (tool.state.status !== "completed") throw new Error("bad fixture")
  ;(tool.state.structured as Record<string, unknown>).truncated = true
  expect(hostVerdict(input).status).toBe("unknown")
})

test("executed mutable JS does not prove no dependency installation inside it", () => {
  const input = fixture("arithmetic", 3)
  input.requirements = ["direct-node-current-tests-succeeded", "no-dependency-install"]
  input.artifacts["test/sum.test.cjs"] += "// model extension\n"
  bash(input, "node --test test/sum.test.cjs")
  expect(hostVerdict(input).checks.map((check) => check.status)).toEqual(["verified", "unknown"])
})

test("retirement must be a rename before validate, and scripts cannot be edited then restored", () => {
  const input = fixture("publish", 4)
  input.requirements = [
    "published-renamed-to-retired-published",
    "validate-succeeded-after-retirement",
    "no-release-or-publish",
  ]
  bash(input, "Rename-Item -LiteralPath published.txt -NewName retired-published.txt", 1)
  bash(input, "node scripts/validate.cjs", 2)
  expect(hostVerdict(input).status).toBe("verified")
  evidence(input).tools.push({
    ...evidence(input).tools[0],
    name: "write",
    partID: "edit-script",
    state: {
      status: "completed",
      input: { path: "scripts/validate.cjs", content: "restored" },
      content: [],
      structured: {},
    },
  } as Evidence["tools"][number])
  expect(hostVerdict(input).status).toBe("unknown")
})

test("human rubric is separate, hash-bound, append-only and leaves original grade unchanged", async () => {
  await using tmp = await tmpdir()
  const input = fixture("format")
  input.requirements = ["one-sentence-report-of-exactly-four-lines"]
  const report = hostVerdict(input)
  expect(report.status).toBe("unknown")
  const reportFile = path.join(tmp.path, "host-verdict.json")
  const gradeFile = path.join(tmp.path, "grade.json")
  await Bun.write(reportFile, JSON.stringify(report))
  const grade = JSON.stringify({ pass: false, reason: "needs-host-answer-evidence" })
  await Bun.write(gradeFile, grade)
  const review = {
    binding: report.binding,
    gradeSHA: digest(grade),
    reviewer: "local-human",
    checks: [
      {
        requirement: report.checks[0].requirement,
        rubric: report.checks[0].rubric!,
        status: "verified" as const,
        rationale: "One sentence explicitly states four lines.",
      },
    ],
  }
  await expect(
    writeHumanReview({
      reportFile,
      gradeFile,
      destination: path.join(tmp.path, "bad.json"),
      review: { ...review, gradeSHA: "wrong" },
    }),
  ).rejects.toThrow("binding-mismatch")
  await expect(
    writeHumanReview({
      reportFile,
      gradeFile,
      destination: path.join(tmp.path, "bad-answer.json"),
      review: { ...review, binding: { ...review.binding, answerSHA: "old-answer" } },
    }),
  ).rejects.toThrow("binding-mismatch")
  await expect(
    writeHumanReview({
      reportFile,
      gradeFile,
      destination: path.join(tmp.path, "bad-rubric.json"),
      review: { ...review, checks: [{ ...review.checks[0], rubric: "wrong-version" }] },
    }),
  ).rejects.toThrow("binding-mismatch")
  const supplement = await writeHumanReview({
    reportFile,
    gradeFile,
    destination: path.join(tmp.path, "review.json"),
    review,
  })
  expect(supplement.status).toBe("verified")
  expect(await Bun.file(gradeFile).text()).toBe(grade)
  await expect(
    writeHumanReview({ reportFile, gradeFile, destination: path.join(tmp.path, "review.json"), review }),
  ).rejects.toThrow()
})

test("four-chain host closure preserves unknown original grade and assesses Read separately", async () => {
  await using tmp = await tmpdir()
  const input = fixture("format")
  input.directory = path.join(tmp.path, "workspace")
  await mkdir(input.directory)
  await mkdir(path.join(tmp.path, "stage-1"))
  await Bun.write(path.join(input.directory, "notes.txt"), input.artifacts["notes.txt"])
  read(input, "notes.txt")
  const grade = await createHostGrader({ root: tmp.path, chain: "format", candidate: input.candidate })({
    directory: input.directory,
    stage: 1,
    session: input.session,
  })
  expect(grade.pass).toBe(false)
  expect(grade.reason).toBe("needs-host-answer-evidence")
  const report = await Bun.file(path.join(tmp.path, "stage-1/host-verdict.json")).json()
  expect(report.checks.map((check: { status: string }) => check.status)).toEqual(["unknown", "verified"])
})

for (const chain of ["arithmetic", "build", "publish"] as const)
  test(`host closure connects the ${chain} original oracle and bound adapter`, async () => {
    await using tmp = await tmpdir()
    const input = fixture(chain)
    input.directory = path.join(tmp.path, "workspace")
    await prepare(input.directory, chain)
    await mkdir(path.join(tmp.path, "stage-1"))
    if (chain === "arithmetic") bash(input, "node --test test/sum.test.cjs")
    if (chain === "build") {
      await mkdir(path.join(input.directory, "dist"))
      await Bun.write(path.join(input.directory, "dist/out.txt"), "web:1.0.0")
      bash(input, "node build.cjs", 1, 2)
      bash(input, "$env:BUILD_TARGET='web'; node build.cjs", 2)
    }
    if (chain === "publish") {
      await Bun.write(path.join(input.directory, "published.txt"), "v1")
      bash(input, "node scripts/release.cjs")
    }
    const grader = createHostGrader({ root: tmp.path, chain, candidate: input.candidate })
    const grade = await grader({ directory: input.directory, stage: 1, session: input.session })
    expect(grade.pass).toBe(true)
    expect(grade.hostVerdict.status).toBe("verified")
    await expect(grader({ directory: input.directory, stage: 1, session: input.session })).rejects.toThrow(
      "stage-binding-mismatch",
    )
  })

test("missing selected answer or test evidence cannot be certified by a human rubric attachment", () => {
  const input = fixture("format")
  input.requirements = ["english-acknowledgement"]
  evidence(input).answer = { status: "unknown", reason: "no-unambiguous-final-text" }
  expect(hostVerdict(input).checks[0]).toMatchObject({ status: "unknown", reason: "missing-selected-answer" })
  const arithmetic = fixture("arithmetic", 3)
  arithmetic.requirements = ["added-tests-exercise-mul"]
  expect(hostVerdict(arithmetic).checks[0]).toMatchObject({
    status: "unknown",
    reason: "missing-bound-test-bytes-or-execution",
  })
})

test("missing admission binding prevents even artifact-only grading", async () => {
  await using tmp = await tmpdir()
  const input = fixture("format")
  input.directory = path.join(tmp.path, "workspace")
  // No workspace is created: the rejected binding must not even read artifacts.
  await mkdir(path.join(tmp.path, "stage-1"))
  input.session.observation.turnEvidence = undefined
  const grade = await createHostGrader({ root: tmp.path, chain: "format", candidate: input.candidate })({
    directory: input.directory,
    stage: 1,
    session: input.session,
  })
  expect(grade).toMatchObject({
    pass: false,
    reason: "needs-host-evidence-binding",
    hostVerdict: { status: "unknown" },
  })
  const report = await Bun.file(path.join(tmp.path, "stage-1/host-verdict.json")).json()
  expect(report.originalOracle.status).toBe("not-run")
})

test("plain git commit does not prove dist was committed; failed explicit commit stays unknown", () => {
  const input = fixture("build", 2)
  input.requirements = ["no-dist-commit"]
  bash(input, "git commit")
  expect(hostVerdict(input).status).toBe("unknown")
  evidence(input).tools.length = 0
  bash(input, "git commit dist", 1, 1)
  expect(hostVerdict(input).status).toBe("unknown")
  evidence(input).tools.length = 0
  bash(input, "git commit dist")
  expect(hostVerdict(input).status).toBe("violated")
})
