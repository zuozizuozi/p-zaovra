import path from "node:path"
import { lstat, readFile, writeFile } from "node:fs/promises"
import { runEvaluationChain } from "./pilot"
import { gradeArithmetic } from "./arithmetic-chain"
import { gradeFormat } from "./format"
import { gradeBuild, gradePublish } from "./build-publish"
import { hostVerdict, combine, digest, humanRubrics } from "./host-verdict"
import { chains } from "./cases"
import type { HostChain, Check, HostReport } from "./host-verdict"

type StageInput = Parameters<Parameters<typeof runEvaluationChain>[0]["grade"]>[0]
type Artifacts = Awaited<ReturnType<typeof gradeArithmetic>>["artifacts"]

/** Opt-in four-chain entry. Budget/transport authorization stays with the calling host. */
export function runHostGradedChain(
  input: Omit<Parameters<typeof runEvaluationChain>[0], "grade" | "capture" | "chainID"> & {
    chainID: HostChain
  },
) {
  return runEvaluationChain({
    ...input,
    capture: { maxBytes: 262144, maxParts: 1000 },
    grade: createHostGrader({ candidate: input.candidate, chain: input.chainID, root: input.root }),
  })
}

/** A fresh closure per chain retains only host-observed previous-stage artifacts. */
export function createHostGrader(input: { candidate: string; chain: HostChain; root: string }) {
  let previousArtifacts: Artifacts | undefined
  let lastStage = 0
  let previousTexts: Record<string, string> = {}
  return async (stage: StageInput) => {
    if (stage.stage !== lastStage + 1 || path.resolve(stage.directory) !== path.resolve(input.root, "workspace"))
      throw new Error("host-grade-stage-binding-mismatch")
    const texts: Record<string, string> = {}
    const checks: Check[] = []
    const readArtifacts =
      input.chain === "arithmetic" && stage.stage === 4
        ? {
            ...(previousTexts["test/sum.test.cjs"] !== undefined
              ? { "test/math.test.cjs": previousTexts["test/sum.test.cjs"] }
              : {}),
            "package.json": chains.find((chain) => chain.id === "arithmetic")!.beforeFourth.write["package.json"]!,
          }
        : undefined
    const base = () => ({
      candidate: input.candidate,
      chain: input.chain,
      stage: stage.stage,
      directory: stage.directory,
      profile: path.join(input.root, "profile"),
      session: stage.session,
      artifacts: texts,
      readArtifacts,
      shell: "powershell" as const,
    })
    const captureArtifacts = async (artifacts: Readonly<Artifacts>) => {
      for (const artifact of artifacts) {
        if (!artifact.pass || !artifact.artifact) continue
        const name = path.join(stage.directory, artifact.name)
        const info = await lstat(name)
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384) continue
        const bytes = await readFile(name)
        if (digest(bytes) === artifact.artifact?.sha256) texts[artifact.name] = bytes.toString("utf8")
      }
    }
    const verifyTools = async (request: { requirements: readonly string[]; artifacts: Readonly<Artifacts> }) => {
      await captureArtifacts(request.artifacts)
      const report = hostVerdict({ ...base(), requirements: request.requirements })
      checks.push(...report.checks)
      return report.status
    }
    const initial = hostVerdict({ ...base(), requirements: [] })
    if (initial.evidenceStatus !== "verified") {
      await writeFile(
        path.join(input.root, `stage-${stage.stage}`, "host-verdict.json"),
        JSON.stringify(
          { ...initial, originalOracle: { status: "not-run", reason: "missing-or-mismatched-host-binding" } },
          null,
          2,
        ),
        { flag: "wx" },
      )
      previousArtifacts = undefined
      previousTexts = {}
      lastStage = stage.stage
      return {
        pass: false,
        reason: "needs-host-evidence-binding",
        hostVerdict: { status: "unknown" as const, file: "host-verdict.json" },
      }
    }
    const evidence = stage.session.observation.turnEvidence
    const answer =
      evidence?.status === "complete" && evidence.answer.status === "selected" ? evidence.answer.text : undefined
    const turn = stage.session.observation.turn
    if (!turn) throw new Error("missing-host-grade-turn")
    const common = { directory: stage.directory, stage: stage.stage, turn, verifyTools }
    const grade =
      input.chain === "arithmetic"
        ? await gradeArithmetic({ ...common, executable: process.execPath, previousArtifacts })
        : input.chain === "format"
          ? await gradeFormat({
              ...common,
              answer,
              verifyAnswer: async (request) => {
                const report = hostVerdict({ ...base(), requirements: request.requirements })
                checks.push(...report.checks)
                return report.status
              },
            })
          : await (input.chain === "build" ? gradeBuild : gradePublish)(common)
    // The original oracle may stop at a failed artifact or unknown human rubric.
    // Preserve that result; an uncalled tool callback is explicitly unassessed.
    const required = "requirements" in grade ? grade.requirements : undefined
    const toolRequirements = Array.isArray(required) ? required : required && "tools" in required ? required.tools : []
    const missing = toolRequirements.filter(
      (requirement: string) => !checks.some((check) => check.requirement === requirement),
    )
    if (missing.length) {
      await verifyTools({ requirements: missing, artifacts: grade.artifacts })
    }
    await captureArtifacts(grade.artifacts)
    const report: HostReport = {
      ...hostVerdict({ ...base(), requirements: [] }),
      checks,
      status: checks.length ? combine(checks.map((check) => check.status)) : grade.pass ? "verified" : "unknown",
    }
    const status = !grade.pass && !grade.reason.startsWith("needs-") ? "violated" : report.status
    const dimension = (selected: Check[]) =>
      selected.length ? combine(selected.map((check) => check.status)) : "not-assessed"
    const appendix = {
      ...report,
      status,
      originalOracle: { pass: grade.pass, reason: grade.reason },
      artifactStatus: grade.artifacts.some((artifact) => !artifact.pass)
        ? "violated"
        : grade.artifacts.length
          ? "verified"
          : "unknown",
      dimensions: {
        commandsAndReads: dimension(checks.filter((check) => !check.rubric && !check.requirement.startsWith("no-"))),
        meaning: dimension(checks.filter((check) => check.rubric !== undefined)),
        prohibitions: dimension(checks.filter((check) => check.requirement.startsWith("no-"))),
      },
      humanRubrics,
      callbacks: checks.length ? "assessed" : "not-required-or-oracle-short-circuited",
    }
    await writeFile(
      path.join(input.root, `stage-${stage.stage}`, "host-verdict.json"),
      JSON.stringify(appendix, null, 2),
      { flag: "wx" },
    )
    previousArtifacts = grade.artifacts
    previousTexts = texts
    lastStage = stage.stage
    return { ...grade, hostVerdict: { status, file: "host-verdict.json" } }
  }
}
