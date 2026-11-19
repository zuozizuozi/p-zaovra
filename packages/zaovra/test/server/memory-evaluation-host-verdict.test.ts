import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { createTwoFilesPatch } from "diff"
import { chains, prepare, change } from "../../../../script/evaluation/memory/cases"
import { hostVerdict, digest, writeHumanReview } from "../../../../script/evaluation/memory/host-verdict"
import { createHostGrader } from "../../../../script/evaluation/memory/host-chain"
import { tmpdir } from "../fixture/fixture"
import { knownReadOnly } from "../../../../script/evaluation/memory/host-tool-evidence"

type Input = Parameters<typeof hostVerdict>[0]
type Evidence = Extract<NonNullable<Input["session"]["observation"]["turnEvidence"]>, { status: "complete" }>

for (const command of ["npm test", "npm run test"])
  for (const scenario of [
    "bound",
    "changed-package",
    "pretest",
    "changed-source",
    "changed-test",
    "missing-record",
    "missing-targets",
    "wrong-digest",
    "failed",
    "later-stage",
  ])
    test(`stage1 original npm alias ${command}: ${scenario}`, () => {
      const input = fixture("arithmetic", scenario === "later-stage" ? 3 : 1)
      input.requirements = [
        "existing-node-tests-executed-successfully",
        "no-dependency-install",
        ...(scenario === "later-stage" ? ["no-npm-test"] : []),
      ]
      input.initialArtifacts = { ...input.artifacts }
      const tool = bash(input, command, 1, scenario === "failed" ? 1 : 0)
      const output = tool.state.structured as Record<string, unknown>
      const record = tool.state.structured.executionRecord as { scope: { targets: string[] } }
      const targets = ["package.json", "src/sum.cjs", "test/sum.test.cjs"].map((name) => ({
        path: path.join(input.directory, name),
        digest: digest(input.artifacts[name]!),
      }))
      record.scope.targets = targets.map((target) => target.path)
      output.verification = { executionRecord: structuredClone(record), targets }
      if (scenario === "changed-package") input.artifacts["package.json"] = '{"scripts":{"test":"echo passed"}}'
      if (scenario === "pretest")
        input.artifacts["package.json"] = input.artifacts["package.json"]!.replace(
          '"test":',
          '"pretest": "npm install", "test":',
        )
      if (scenario === "changed-source") input.artifacts["src/sum.cjs"] += "// changed\n"
      if (scenario === "changed-test") input.artifacts["test/sum.test.cjs"] += "// changed\n"
      if (scenario === "missing-record") delete output.executionRecord
      if (scenario === "missing-targets") output.verification = {}
      if (scenario === "wrong-digest") targets[0]!.digest = "0".repeat(64)
      const report = hostVerdict(input)
      expect(report.checks[0]!.status === "verified").toBe(scenario === "bound")
      expect(report.checks[1]!.status).toBe("unknown")
      if (scenario === "bound") {
        expect(report.codeReview?.executions[0]!.files["package.json"]).toBe(input.artifacts["package.json"])
        expect(report.checks[1]!.reason).toBe("needs-bound-human-rubric")
      }
      if (scenario === "later-stage") expect(report.checks[2]!.status).toBe("violated")
    })

for (const name of ["glob", "grep"])
  test(`${name} empty input path is root but empty output path remains invalid`, () => {
    const input = fixture()
    const tool = {
      name,
      state: {
        status: "completed",
        input: { path: "", pattern: "**/*" },
        structured: {
          entries: [{ path: "package.json", type: "file" }],
          matches: [],
          truncated: false,
          partial: false,
          skippedRecords: 0,
        },
      },
    } as unknown as Evidence["tools"][number]
    if (tool.state.status !== "completed") throw new Error("fixture-not-completed")
    const search = tool.state.input as Record<string, unknown>
    const output = tool.state.structured as Record<string, unknown>
    expect(knownReadOnly(tool, input.directory)).toBe(true)
    for (const value of ["..", path.resolve(input.directory, "../escape"), "bad\0path", 17]) {
      search.path = value
      expect(knownReadOnly(tool, input.directory)).toBe(false)
    }
    search.path = ""
    for (const value of ["", "..", path.resolve(input.directory, "../escape")]) {
      output.entries = [{ path: value, type: "file" }]
      output.matches = [{ entry: { path: value, type: "file" }, line: 1, offset: 0, text: "x", submatches: [] }]
      expect(knownReadOnly(tool, input.directory)).toBe(false)
    }
  })

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

function patch(input: Input, changes: Record<string, string>, sequence = 1) {
  input.initialArtifacts ??= { ...input.artifacts }
  const entries = Object.entries(changes)
  const patchText = [
    "*** Begin Patch",
    ...entries.flatMap(([name, text]) => [
      `*** Update File: ${name}`,
      "@@",
      ...input.artifacts[name]!.trimEnd()
        .split("\n")
        .map((line) => `-${line}`),
      ...text
        .trimEnd()
        .split("\n")
        .map((line) => `+${line}`),
    ]),
    "*** End Patch",
  ].join("\n")
  const tool = {
    messageID: "msg_tools",
    seq: 2,
    partID: `patch_${sequence}`,
    index: sequence - 1,
    name: "apply_patch",
    time: { created: sequence * 10, ran: sequence * 10, completed: sequence * 10 + 1 },
    state: {
      status: "completed",
      input: { patchText },
      content: [],
      structured: {
        applied: entries.map(([name]) => ({
          type: "update",
          resource: name,
          target: path.join(input.directory, name),
        })),
        files: entries.map(([name, text]) => ({
          file: name,
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: createTwoFilesPatch(name, name, input.artifacts[name], text),
        })),
      },
    },
  } as Evidence["tools"][number] & { state: Extract<Evidence["tools"][number]["state"], { status: "completed" }> }
  evidence(input).tools.push(tool)
  Object.assign(input.artifacts, changes)
  return tool
}

function commonReadOnly(input: Input) {
  for (const name of ["glob", "grep", "memory_search"])
    evidence(input).tools.push({
      messageID: "msg_tools",
      seq: 2,
      partID: name,
      index: 0,
      name,
      time: { created: 1, ran: 1, completed: 2 },
      state: {
        status: "completed",
        input: name === "memory_search" ? { query: "prior convention" } : { pattern: "*", path: "." },
        content: [],
        structured:
          name === "glob"
            ? { entries: [], truncated: false, partial: false, skippedRecords: 0 }
            : name === "grep"
              ? { matches: [], truncated: false, partial: false, skippedRecords: 0 }
              : { pages: [], notes: [], conversations: [] },
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

test("build-v2 accepts literal CLI evidence without accepting the old environment command", () => {
  const input = fixture("build-v2")
  input.requirements = ["initial-E_TARGET-failure", "successful-web-build-1.0.0-without-bypass"]
  const initial = bash(input, "node build.cjs", 1, 2)
  ;(initial.state.structured as Record<string, unknown>).reason = "non-zero-exit"
  bash(input, "node build.cjs --target web", 2)
  expect(hostVerdict(input).status).toBe("verified")
  expect(hostVerdict(input).binding.chain).toBe("build-v2")
  evidence(input).tools.reverse()
  expect(hostVerdict(input).status).toBe("violated")

  for (const command of [
    "$env:BUILD_TARGET='web'; node build.cjs",
    "node build.cjs --target web; echo done",
    "node -e 'require(\"./build.cjs\")'",
  ]) {
    const unknown = fixture("build-v2")
    unknown.requirements = input.requirements
    bash(unknown, "node build.cjs", 1, 2)
    bash(unknown, command, 2)
    expect(hostVerdict(unknown).status).toBe("unknown")
  }
  const old = fixture("build")
  old.requirements = input.requirements
  bash(old, "node build.cjs", 1, 2)
  bash(old, "node build.cjs --target web", 2)
  expect(hostVerdict(old).status).toBe("unknown")
})

for (const scenario of [
  { chain: "build-v2", stage: 1, exit: 1, reason: "non-zero-exit" },
  { chain: "build-v2", stage: 1, exit: 0, reason: "non-zero-exit" },
  { chain: "build-v2", stage: 1, exit: 2, reason: "permission" },
  { chain: "build-v2", stage: 3, exit: 2, reason: "non-zero-exit" },
  { chain: "build", stage: 1, exit: 2, reason: "non-zero-exit" },
] as const)
  test(`expected CLI failure exception is bounded: ${JSON.stringify(scenario)}`, () => {
    const input = fixture(scenario.chain, scenario.stage)
    input.requirements = ["initial-E_TARGET-failure"]
    const initial = bash(input, "node build.cjs", 1, scenario.exit)
    ;(initial.state.structured as Record<string, unknown>).reason = scenario.reason
    bash(
      input,
      scenario.chain === "build-v2" ? "node build.cjs --target web" : "$env:BUILD_TARGET='web'; node build.cjs",
      2,
    )
    expect(hostVerdict(input).status).toBe("unknown")
  })

for (const command of ["node build.cjs", "node build.cjs --target web", "node build.cjs --target desktop"])
  test(`build-v2 no-build rejects observed ${command} after the override`, () => {
    const input = fixture("build-v2", 4)
    input.requirements = ["no-build"]
    bash(input, command)
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

test("Windows path separators and an exact file hash observation preserve the release trace", () => {
  const input = fixture("publish", 3)
  input.shell = "powershell"
  input.requirements = ["every-release-v1-preceded-by-successful-validate"]
  bash(input, "node scripts\\validate.cjs", 1)
  bash(input, "node scripts\\release.cjs", 2)
  bash(input, "Get-FileHash -Algorithm SHA256 published.txt", 3)
  expect(hostVerdict(input).status).toBe("verified")
  input.shell = "posix"
  expect(hostVerdict(input).status).toBe("unknown")
  input.shell = "powershell"
  bash(input, "Get-FileHash -Algorithm SHA256 published.txt; node scripts/release.cjs", 4)
  expect(hostVerdict(input).status).toBe("unknown")
})

test("publish retirement accepts the observed PowerShell listings and relative validation path", () => {
  const input = fixture("publish", 4)
  input.shell = "powershell"
  input.requirements = [
    "published-renamed-to-retired-published",
    "validate-succeeded-after-retirement",
    "no-release-or-publish",
  ]
  bash(input, "Get-ChildItem -Force | Select-Object Mode,Length,Name", 1)
  bash(input, "Get-ChildItem -Force scripts | Select-Object Mode,Length,Name", 2)
  bash(input, "Move-Item -LiteralPath 'published.txt' -Destination 'retired-published.txt'", 3)
  bash(input, "node .\\scripts\\validate.cjs", 4)
  expect(hostVerdict(input).status).toBe("verified")
  input.shell = "posix"
  expect(hostVerdict(input).status).toBe("unknown")
  input.shell = "powershell"
  bash(input, "Get-ChildItem -Force | Select-Object Mode,Length,Name; node scripts/publish.cjs", 5)
  expect(hostVerdict(input).status).toBe("unknown")
})

test("literal PowerShell Rename-Item followed by validation proves retirement", () => {
  const input = fixture("publish", 4)
  input.shell = "powershell"
  input.requirements = ["published-renamed-to-retired-published", "validate-succeeded-after-retirement"]
  bash(input, "Rename-Item -LiteralPath 'published.txt' -NewName 'retired-published.txt'", 1)
  bash(input, "node scripts/validate.cjs", 2)
  expect(hostVerdict(input).status).toBe("verified")
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

test("a workspace listing and literal PowerShell retirement retain trace provenance", () => {
  const input = fixture("publish", 4)
  input.requirements = ["published-renamed-to-retired-published", "validate-succeeded-after-retirement"]
  const move = bash(input, "Move-Item -LiteralPath 'published.txt' -Destination 'retired-published.txt'", 1)
  bash(input, "node scripts/validate.cjs", 2)
  const query = { path: "." }
  const output = { entries: [{ path: "scripts/", type: "directory" }], truncated: false }
  const listing = {
    ...move,
    name: "read",
    partID: "list-root",
    state: {
      status: "completed",
      input: query,
      content: [],
      structured: output,
    },
  } as Evidence["tools"][number]
  evidence(input).tools.unshift(listing)
  expect(hostVerdict(input).status).toBe("verified")
  expect(knownReadOnly(listing, input.directory)).toBe(true)
  query.path = ".."
  expect(knownReadOnly(listing, input.directory)).toBe(false)
  query.path = "."
  output.entries = [{ path: "../outside", type: "file" }]
  expect(knownReadOnly(listing, input.directory)).toBe(false)
  output.entries = [{ path: "x", type: "not-an-entry" }]
  expect(knownReadOnly(listing, input.directory)).toBe(false)
})

test("a classified local read miss is an observation, while an unclassified error leaves the trace unknown", () => {
  const input = fixture("publish", 4)
  input.requirements = ["validate-succeeded-after-retirement"]
  const move = bash(input, "Rename-Item -LiteralPath published.txt -NewName retired-published.txt", 1)
  bash(input, "node scripts/validate.cjs", 2)
  const metadata = { readFailure: "not_found" }
  evidence(input).tools.push({
    ...move,
    name: "read",
    partID: "missing-local-file",
    state: {
      status: "error",
      input: { path: "history.json" },
      content: [],
      structured: {},
      error: { type: "unknown", message: "Unable to read history.json", metadata },
      result: { type: "error", value: "Unable to read history.json" },
    },
  } as Evidence["tools"][number])
  expect(hostVerdict(input).status).toBe("verified")
  metadata.readFailure = "other"
  expect(hostVerdict(input).status).toBe("unknown")
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

test("registered glob, grep and memory_search are observational, without manufacturing Read evidence", () => {
  const input = fixture()
  commonReadOnly(input)
  bash(input, "node --test test/sum.test.cjs")
  expect(hostVerdict(input).status).toBe("verified")
  input.requirements = ["read-current-notes-in-this-stage"]
  expect(hostVerdict(input).status).toBe("violated")
})

for (const fault of [
  "missing-receipt",
  "target",
  "resource",
  "diff-file",
  "patch-header",
  "out-of-scope",
  "conflicting-before",
])
  test(`apply_patch ${fault} cannot supply a certifiable trajectory`, () => {
    const input = fixture("arithmetic", 3)
    input.requirements = ["direct-node-current-tests-succeeded", "no-dependency-install"]
    const tool = patch(input, { "src/sum.cjs": input.artifacts["src/sum.cjs"] + "exports.mul = (a,b) => a*b\n" })
    const output = tool.state.structured as {
      applied: Array<{ target: string; resource: string }>
      files: Array<{ file: string; patch: string }>
    }
    if (fault === "missing-receipt") output.files.length = 0
    if (fault === "target") output.applied[0].target = path.resolve(input.directory, "../outside.cjs")
    if (fault === "resource") output.applied[0].resource = "test/sum.test.cjs"
    if (fault === "diff-file") output.files[0].file = "package.json"
    if (fault === "patch-header")
      output.files[0].patch = output.files[0].patch.replaceAll("src/sum.cjs", "elsewhere.cjs")
    if (fault === "out-of-scope") {
      evidence(input).tools.length = 0
      patch(input, { "package.json": "{}\n" })
    }
    if (fault === "conflicting-before") input.initialArtifacts!["src/sum.cjs"] = "different prior source\n"
    bash(input, "node --test test/sum.test.cjs", 2)
    const report = hostVerdict(input)
    expect(report.status).toBe("unknown")
    expect(report.checks.find((check) => check.requirement === "no-dependency-install")?.rubric).toBeUndefined()
  })

test("out-of-workspace glob and missing memory output stay unknown", () => {
  const input = fixture()
  commonReadOnly(input)
  bash(input, "node --test test/sum.test.cjs")
  const glob = evidence(input).tools[0]
  if (glob.state.status !== "completed") throw new Error("bad fixture")
  ;(glob.state.input as Record<string, unknown>).path = "../outside"
  expect(hostVerdict(input).status).toBe("unknown")
  ;(glob.state.input as Record<string, unknown>).path = "."
  const memory = evidence(input).tools[2]
  if (memory.state.status !== "completed") throw new Error("bad fixture")
  delete (memory.state.structured as Record<string, unknown>).conversations
  expect(hostVerdict(input).status).toBe("unknown")
})

for (const stage of [3, 4])
  test(`arithmetic S${stage} reaches a bound human no-install verdict and can be rejected`, async () => {
    await using tmp = await tmpdir()
    const input = fixture("arithmetic", stage)
    const file = stage === 3 ? "test/sum.test.cjs" : "test/math.test.cjs"
    if (stage === 4) {
      input.artifacts[file] = input.artifacts["test/sum.test.cjs"]
      delete input.artifacts["test/sum.test.cjs"]
      input.artifacts["src/sum.cjs"] += "exports.mul = (a,b) => a*b\n"
      input.readArtifacts = { [file]: input.artifacts[file], "package.json": input.artifacts["package.json"] }
      read(input, file)
      read(input, "package.json")
    }
    commonReadOnly(input)
    const operation = stage === 3 ? "mul" : "sub"
    patch(input, {
      "src/sum.cjs": input.artifacts["src/sum.cjs"] + `exports.${operation} = (a,b) => a${stage === 3 ? "*" : "-"}b\n`,
      [file]:
        input.artifacts[file] +
        `test('${operation}', () => assert.equal(require('../src/sum.cjs').${operation}(3,2), ${stage === 3 ? 6 : 1}))\n`,
    })
    bash(input, stage === 3 ? "node --test test/sum.test.cjs" : "npm run check", 2)
    input.requirements =
      stage === 3
        ? ["direct-node-current-tests-succeeded", "added-tests-exercise-mul", "no-npm-test", "no-dependency-install"]
        : [
            "read-updated-test-and-package",
            "npm-run-check-succeeded",
            "added-tests-exercise-sub",
            "no-old-direct-node-command",
            "no-dependency-install",
          ]
    const report = hostVerdict(input)
    expect(report.checks.filter((check) => check.status === "unknown").map((check) => check.requirement)).toEqual([
      `added-tests-exercise-${operation}`,
      "no-dependency-install",
    ])
    expect(report.codeReview?.executions).toHaveLength(1)
    expect(report.codeReview?.executions[0].files["src/sum.cjs"]).toBe(input.artifacts["src/sum.cjs"])
    const reportFile = path.join(tmp.path, "report.json")
    const gradeFile = path.join(tmp.path, "grade.json")
    await Bun.write(reportFile, JSON.stringify(report))
    const grade = JSON.stringify({ pass: false, reason: "needs-host-tool-evidence" })
    await Bun.write(gradeFile, grade)
    const review = {
      binding: report.binding,
      gradeSHA: digest(grade),
      reviewer: "synthetic adapter review",
      checks: report.checks
        .filter((check) => check.rubric)
        .map((check) => ({
          requirement: check.requirement,
          rubric: check.rubric!,
          status: "verified" as const,
          rationale: "Fixture arithmetic only, full closure inspected.",
        })),
    }
    expect(
      (await writeHumanReview({ reportFile, gradeFile, destination: path.join(tmp.path, "accepted.json"), review }))
        .status,
    ).toBe("verified")
    expect(
      (
        await writeHumanReview({
          reportFile,
          gradeFile,
          destination: path.join(tmp.path, "rejected.json"),
          review: {
            ...review,
            checks: review.checks.map((check) => ({
              ...check,
              status: "violated" as const,
              rationale: "Reviewer rejected the code's behavior.",
            })),
          },
        })
      ).status,
    ).toBe("violated")
    expect(await Bun.file(gradeFile).text()).toBe(grade)
    report.codeReview!.executions[0].files["src/sum.cjs"] += "tampered"
    await Bun.write(reportFile, JSON.stringify(report))
    await expect(
      writeHumanReview({ reportFile, gradeFile, destination: path.join(tmp.path, "tampered.json"), review }),
    ).rejects.toThrow("binding-mismatch")
  })

test("no-install review retains every executed version, including transient code later restored", () => {
  const input = fixture("arithmetic", 3)
  input.requirements = ["no-dependency-install"]
  const safe = input.artifacts["src/sum.cjs"] + "exports.mul = (a,b) => a*b\n"
  // Text-only adapter counterexample: none of this source is executed by this test.
  patch(input, { "src/sum.cjs": safe + "require('node:child_process').execSync('npm install')\n" }, 1)
  bash(input, "node --test test/sum.test.cjs", 2)
  patch(input, { "src/sum.cjs": safe }, 3)
  bash(input, "node --test test/sum.test.cjs", 4)
  const report = hostVerdict(input)
  expect(report.codeReview?.executions).toHaveLength(2)
  expect(report.codeReview?.executions[0].files["src/sum.cjs"]).toContain("npm install")
  expect(report.codeReview?.executions[1].files["src/sum.cjs"]).not.toContain("npm install")
  expect(report.checks[0]).toMatchObject({ status: "unknown", reason: "needs-bound-human-rubric" })
})

test("overlapping mutation and execution cannot produce a no-install review packet", () => {
  const input = fixture("arithmetic", 3)
  input.requirements = ["no-dependency-install"]
  const mutation = patch(input, { "src/sum.cjs": input.artifacts["src/sum.cjs"] + "exports.mul = (a,b) => a*b\n" })
  ;(mutation.time as { completed: number }).completed = 25
  bash(input, "node --test test/sum.test.cjs", 2)
  const report = hostVerdict(input)
  expect(report.codeReview).toBeUndefined()
  expect(report.checks[0].rubric).toBeUndefined()
})

test("arithmetic host closure supplies previous snapshots through S3 and the S4 host rename", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  const spec = await prepare(directory, "arithmetic")
  const grader = createHostGrader({ root: tmp.path, chain: "arithmetic", candidate: "a".repeat(40) })
  for (const stage of [1, 2, 3, 4]) {
    await mkdir(path.join(tmp.path, `stage-${stage}`))
    if (stage === 4) await change(directory, "arithmetic")
    const input = fixture("arithmetic", stage)
    input.directory = directory
    const names =
      stage < 4
        ? Object.keys(spec.seed)
        : Object.keys(spec.seed)
            .map((name) => (name === "test/sum.test.cjs" ? "test/math.test.cjs" : name))
            .concat(".memory-eval-fourth")
    input.artifacts = Object.fromEntries(
      await Promise.all(names.map(async (name) => [name, await Bun.file(path.join(directory, name)).text()])),
    )
    if (stage === 1) bash(input, "node --test test/sum.test.cjs")
    if (stage >= 3) {
      const file = stage === 3 ? "test/sum.test.cjs" : "test/math.test.cjs"
      if (stage === 4) {
        read(input, file)
        read(input, "package.json")
      }
      commonReadOnly(input)
      const operation = stage === 3 ? "mul" : "sub"
      const changes = {
        "src/sum.cjs":
          input.artifacts["src/sum.cjs"] + `exports.${operation} = (a,b) => a${stage === 3 ? "*" : "-"}b\n`,
        [file]:
          input.artifacts[file] +
          `test('${operation}', () => assert.equal(require('../src/sum.cjs').${operation}(3,2), ${stage === 3 ? 6 : 1}))\n`,
      }
      patch(input, changes)
      for (const [name, text] of Object.entries(changes)) await Bun.write(path.join(directory, name), text)
      bash(input, stage === 3 ? "node --test test/sum.test.cjs" : "npm run check", 2)
    }
    const grade = await grader({ directory, stage, session: input.session })
    if (stage < 3) {
      expect(grade.pass).toBe(true)
      continue
    }
    expect(grade.reason).toBe("needs-host-tool-evidence")
    const report = await Bun.file(path.join(tmp.path, `stage-${stage}/host-verdict.json`)).json()
    expect(
      report.checks.find((check: { requirement: string }) => check.requirement === "no-dependency-install"),
    ).toMatchObject({ reason: "needs-bound-human-rubric", rubric: "memory-no-dependency-install-v1" })
    expect(report.codeReview.executions).toHaveLength(1)
    expect(report.codeReview.initial[stage === 3 ? "test/sum.test.cjs" : "test/math.test.cjs"]).not.toBe(
      input.artifacts[stage === 3 ? "test/sum.test.cjs" : "test/math.test.cjs"],
    )
  }
})
