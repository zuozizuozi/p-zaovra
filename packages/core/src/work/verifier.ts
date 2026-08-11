export * as WorkVerifier from "./verifier"

import { Work } from "@zaovra-ai/schema/work"
import { Cause, Context, DateTime, Duration, Effect, Exit, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { resolve } from "node:path"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { AppProcess } from "../process"
import { WorkRemoteJob } from "./remote-job"

const MAX_OUTPUT_BYTES = 128 * 1024
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000
const VERSION = "1"

export type Input = {
  readonly goal: Work.GoalInfo
  readonly task: Work.TaskInfo
  readonly attempt: Work.AttemptInfo
  readonly criterion: Work.Criterion
}

export type Result = {
  readonly evidence: Work.EvidenceInfo
  readonly evaluation: Work.EvaluationInfo
}

export interface Interface {
  readonly evaluate: (input: Input) => Effect.Effect<Result>
  readonly evaluateEvidence: (input: Input, evidence: Work.EvidenceInfo) => Effect.Effect<Work.EvaluationInfo>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkVerifier") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const appProcess = yield* AppProcess.Service
    const remoteJobs = yield* WorkRemoteJob.Service

    return Service.of({
      evaluate: Effect.fn("WorkVerifier.evaluate")(function* (input) {
        const verifier = input.criterion.verifier
        if (!verifier) return yield* Effect.die(`Criterion has no verifier: ${input.criterion.id}`)
        const location = input.task.location ?? input.goal.location
        const artifactCapture =
          verifier.type === "command" && ["diff", "artifact"].includes(input.criterion.evidence)
            ? yield* captureSpec(git, location)
            : undefined
        const remote = yield* remoteJobs.dispatch({
          workerID: input.goal.workerID,
          goalID: input.goal.id,
          attemptID: input.attempt.id,
          criterionID: input.criterion.id,
          operation:
            verifier.type === "command"
              ? Work.WorkerCommandOperation.make({
                  type: "command",
                  command: verifier.command,
                  location,
                  timeoutMs: verifier.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                  maxOutputBytes: MAX_OUTPUT_BYTES,
                  ...(artifactCapture ? { artifactCapture } : {}),
                })
              : Work.WorkerFileOperation.make({
                  type: "file",
                  path: verifier.path,
                  expected: verifier.expected,
                  location,
                }),
        })
        if (remote) return remoteResult(input, remote, yield* DateTime.now)
        if (verifier.type === "file") return yield* evaluateFile(fs, input, verifier)
        return yield* evaluateCommand(appProcess, input, verifier)
      }),
      evaluateEvidence: Effect.fn("WorkVerifier.evaluateEvidence")(function* (input, evidence) {
        return makeEvaluation(input, evidence, outcomeFromEvidence(input, evidence), yield* DateTime.now)
      }),
    })
  }),
)

function evaluateCommand(appProcess: AppProcess.Interface, input: Input, verifier: Work.CommandVerifier) {
  return Effect.gen(function* () {
    const directory = (input.task.location ?? input.goal.location).directory
    const command = ChildProcess.make(verifier.command, [], {
      cwd: directory,
      shell: process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh",
      stdin: "ignore",
      detached: process.platform !== "win32",
      forceKillAfter: Duration.seconds(3),
    })
    const exit = yield* appProcess
      .run(command, {
        combineOutput: true,
        timeout: Duration.millis(verifier.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        maxOutputBytes: MAX_OUTPUT_BYTES,
      })
      .pipe(Effect.exit)
    const createdAt = yield* DateTime.now
    if (Exit.isFailure(exit)) {
      const message = errorText(Cause.squash(exit.cause))
      return makeResult(input, createdAt, {
        payload: {
          type: "command",
          command: verifier.command,
          directory,
          error: message,
        },
        verdict: "blocked",
        findings: [{ message: `Verifier could not run: ${message}`, severity: "error" }],
        allowsRepair: false,
      })
    }

    const success = (verifier.successExitCodes ?? [0]).includes(exit.value.exitCode)
    const output = exit.value.output?.toString("utf8") ?? ""
    return makeResult(input, createdAt, {
      payload: {
        type: "command",
        command: verifier.command,
        directory,
        exitCode: exit.value.exitCode,
        output,
        outputTruncated: exit.value.outputTruncated === true,
      },
      verdict: success ? "pass" : "fail",
      findings: success
        ? []
        : [
            {
              code: "unexpected_exit",
              message: `Verifier exited with code ${exit.value.exitCode}: ${verifier.command}`,
              severity: "error",
            },
          ],
      allowsRepair: !success,
    })
  })
}

function evaluateFile(fs: FSUtil.Interface, input: Input, verifier: Work.FileVerifier) {
  return Effect.gen(function* () {
    const directory = (input.task.location ?? input.goal.location).directory
    const target = resolve(directory, verifier.path)
    const createdAt = yield* DateTime.now
    if (!FSUtil.contains(directory, target)) {
      return makeResult(input, createdAt, {
        payload: { type: "file", path: verifier.path, target, actual: "outside_workspace" },
        verdict: "blocked",
        findings: [{ message: `Verifier path is outside the workspace: ${target}`, severity: "error" }],
        allowsRepair: false,
      })
    }

    const exists = yield* fs.existsSafe(target)
    const actual = !exists
      ? "missing"
      : (yield* fs.isFile(target))
        ? "file"
        : (yield* fs.isDir(target))
          ? "directory"
          : "other"
    const success = verifier.expected === "exists" ? exists : verifier.expected === actual
    return makeResult(input, createdAt, {
      payload: { type: "file", path: verifier.path, target, expected: verifier.expected, actual },
      verdict: success ? "pass" : "fail",
      findings: success
        ? []
        : [
            {
              code: "artifact_mismatch",
              message: `Expected ${verifier.path} to be ${verifier.expected}, found ${actual}`,
              severity: "error",
              location: target,
            },
          ],
      allowsRepair: !success,
    })
  })
}

function remoteResult(input: Input, result: Work.WorkerJobResult, createdAt: DateTime.Utc): Result {
  const verifier = input.criterion.verifier
  const directory = (input.task.location ?? input.goal.location).directory
  if (result.type === "command" && verifier?.type === "command") {
    if (result.error)
      return makeResult(input, createdAt, {
        payload: { type: "command", command: verifier.command, directory, error: result.error },
        verdict: "blocked",
        findings: [{ message: `Remote verifier could not run: ${result.error}`, severity: "error" }],
        allowsRepair: false,
      })
    if (result.exitCode === undefined)
      return makeResult(input, createdAt, {
        payload: { type: "command", command: verifier.command, directory, error: "Missing remote exit code" },
        verdict: "blocked",
        findings: [{ message: "Remote verifier returned no exit code", severity: "error" }],
        allowsRepair: false,
      })
    const success = (verifier.successExitCodes ?? [0]).includes(result.exitCode)
    if (result.artifactError)
      return makeResult(input, createdAt, {
        payload: {
          type: "command",
          command: verifier.command,
          directory,
          exitCode: result.exitCode,
          error: result.artifactError,
          ...(result.baseRevision ? { baseRevision: result.baseRevision } : {}),
        },
        verdict: "blocked",
        findings: [{ message: `Remote artifact capture failed: ${result.artifactError}`, severity: "error" }],
        allowsRepair: false,
      })
    const artifact = result.artifacts?.[0]
    return makeResult(input, createdAt, {
      payload: {
        type: "command",
        command: verifier.command,
        directory,
        exitCode: result.exitCode,
        output: result.output ?? "",
        outputTruncated: result.outputTruncated,
        ...(result.baseRevision ? { baseRevision: result.baseRevision } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
      },
      verdict: success ? "pass" : "fail",
      findings: success
        ? []
        : [
            {
              code: "unexpected_exit",
              message: `Remote verifier exited with code ${result.exitCode}: ${verifier.command}`,
              severity: "error",
            },
          ],
      allowsRepair: !success,
      artifact,
    })
  }
  if (result.type === "file" && verifier?.type === "file") {
    if (result.error || !result.actual)
      return makeResult(input, createdAt, {
        payload: {
          type: "file",
          path: verifier.path,
          ...(result.target ? { target: result.target } : {}),
          error: result.error ?? "Missing remote file result",
        },
        verdict: "blocked",
        findings: [
          { message: `Remote verifier could not run: ${result.error ?? "missing result"}`, severity: "error" },
        ],
        allowsRepair: false,
      })
    const success = verifier.expected === "exists" ? result.actual !== "missing" : verifier.expected === result.actual
    return makeResult(input, createdAt, {
      payload: {
        type: "file",
        path: verifier.path,
        ...(result.target ? { target: result.target } : {}),
        expected: verifier.expected,
        actual: result.actual,
      },
      verdict: success ? "pass" : "fail",
      findings: success
        ? []
        : [
            {
              code: "artifact_mismatch",
              message: `Expected ${verifier.path} to be ${verifier.expected}, found ${result.actual}`,
              severity: "error",
              location: result.target,
            },
          ],
      allowsRepair: !success,
    })
  }
  return makeResult(input, createdAt, {
    payload: { type: "remote", error: "Remote verifier result type mismatch" },
    verdict: "blocked",
    findings: [{ message: "Remote verifier result type mismatch", severity: "error" }],
    allowsRepair: false,
  })
}

function makeResult(
  input: Input,
  createdAt: DateTime.Utc,
  result: {
    readonly payload: Work.EvidenceInfo["payload"]
    readonly verdict: Work.Verdict
    readonly findings: ReadonlyArray<Work.Finding>
    readonly allowsRepair: boolean
    readonly artifact?: Work.ArtifactReference
  },
) {
  const digest = hash(JSON.stringify(result.payload))
  const evidenceID = id(input)
  const evidence = Work.EvidenceInfo.make({
    id: evidenceID,
    goalID: input.goal.id,
    taskID: input.task.id,
    attemptID: input.attempt.id,
    criterionIDs: [input.criterion.id],
    kind: input.criterion.evidence,
    producer: `work-verifier/${input.criterion.verifier?.type ?? "unknown"}`,
    payload: result.payload,
    digest: result.artifact?.digest ?? digest,
    reference: result.artifact?.reference,
    createdAt,
  })
  return {
    evidence,
    evaluation: makeEvaluation(input, evidence, result, createdAt),
  }
}

function makeEvaluation(
  input: Input,
  evidence: Work.EvidenceInfo,
  result: {
    readonly verdict: Work.Verdict
    readonly findings: ReadonlyArray<Work.Finding>
    readonly allowsRepair: boolean
  },
  createdAt: DateTime.Utc,
) {
  return Work.EvaluationInfo.make({
    id: Work.EvaluationID.make(`evaluation_${hash(`${evidence.id}:${VERSION}`)}`),
    goalID: input.goal.id,
    taskID: input.task.id,
    attemptID: input.attempt.id,
    criterionID: input.criterion.id,
    evidenceIDs: [evidence.id],
    verdict: result.verdict,
    evaluator: "work-verifier",
    evaluatorVersion: VERSION,
    findings: result.findings,
    allowsRepair: result.allowsRepair,
    createdAt,
  })
}

function outcomeFromEvidence(input: Input, evidence: Work.EvidenceInfo) {
  const payload = evidence.payload
  if (!isRecord(payload)) return malformedEvidence()
  if (input.criterion.verifier?.type === "command") {
    if (typeof payload.error === "string")
      return {
        verdict: "blocked" as const,
        findings: [{ message: `Verifier could not run: ${payload.error}`, severity: "error" as const }],
        allowsRepair: false,
      }
    if (typeof payload.exitCode !== "number") return malformedEvidence()
    const success = (input.criterion.verifier.successExitCodes ?? [0]).includes(payload.exitCode)
    return {
      verdict: success ? ("pass" as const) : ("fail" as const),
      findings: success
        ? []
        : [
            {
              code: "unexpected_exit",
              message: `Verifier exited with code ${payload.exitCode}: ${input.criterion.verifier.command}`,
              severity: "error" as const,
            },
          ],
      allowsRepair: !success,
    }
  }
  if (input.criterion.verifier?.type === "file" && typeof payload.actual === "string") {
    if (payload.actual === "outside_workspace")
      return {
        verdict: "blocked" as const,
        findings: [
          {
            message: `Verifier path is outside the workspace: ${typeof payload.target === "string" ? payload.target : input.criterion.verifier.path}`,
            severity: "error" as const,
          },
        ],
        allowsRepair: false,
      }
    const success =
      input.criterion.verifier.expected === "exists"
        ? payload.actual !== "missing"
        : input.criterion.verifier.expected === payload.actual
    return {
      verdict: success ? ("pass" as const) : ("fail" as const),
      findings: success
        ? []
        : [
            {
              code: "artifact_mismatch",
              message: `Expected ${input.criterion.verifier.path} to be ${input.criterion.verifier.expected}, found ${payload.actual}`,
              severity: "error" as const,
              location: typeof payload.target === "string" ? payload.target : undefined,
            },
          ],
      allowsRepair: !success,
    }
  }
  if (input.criterion.verifier?.type === "file" && typeof payload.error === "string")
    return {
      verdict: "blocked" as const,
      findings: [{ message: `Verifier could not run: ${payload.error}`, severity: "error" as const }],
      allowsRepair: false,
    }
  return malformedEvidence()
}

function malformedEvidence() {
  return {
    verdict: "blocked" as const,
    findings: [
      { code: "malformed_evidence", message: "Persisted verifier evidence is malformed", severity: "error" as const },
    ],
    allowsRepair: false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function id(input: Input) {
  return Work.EvidenceID.make(`evidence_${hash(`${input.attempt.id}:${input.criterion.id}:${VERSION}`)}`)
}

const captureSpec = Effect.fn("WorkVerifier.captureSpec")(function* (
  git: Git.Interface,
  location: Work.TaskInfo["location"],
) {
  if (!location) return undefined
  const repository = yield* git.repo.discover(location.directory)
  if (!repository) return undefined
  const baseRevision = yield* git.history.head(repository)
  if (!baseRevision || !/^[a-f0-9]{40,64}$/.test(baseRevision)) return undefined
  return Work.WorkerGitDiffCapture.make({
    type: "git_diff",
    baseRevision,
    maxBytes: WorkRemoteJob.maxArtifactBytes,
  })
})

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Git.node, AppProcess.node, WorkRemoteJob.node],
})
