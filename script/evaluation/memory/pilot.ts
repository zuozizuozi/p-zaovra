import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile, access } from "node:fs/promises"
import { createHash } from "node:crypto"
import { prepare, change } from "./cases"
import { gradeBilling } from "./billing"
import { runEvaluationSession } from "./session"

/** One frozen five-Session A/B pilot, not the full multi-chain acceptance or complete billing ledger.
 * The outer host admits the reserve before calling this and owns the resource-limited process tree.
 */
export async function runBillingChain(input: {
  root: string
  candidate: string
  family: "gpt" | "deepseek"
  modelID: string
  treatment: "A" | "B"
  baseURL: string
  reserveTokens: number
  environment: Record<string, string>
}) {
  const endpoint = new URL(input.baseURL)
  if (
    !path.isAbsolute(input.root) ||
    !/^[a-f0-9]{40}$/.test(input.candidate) ||
    !["gpt", "deepseek"].includes(input.family) ||
    !["A", "B"].includes(input.treatment) ||
    !input.modelID.trim() ||
    !Number.isSafeInteger(input.reserveTokens) ||
    input.reserveTokens < 1 ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1"))
  )
    throw new Error("invalid-billing-pilot")
  const source = path.resolve(import.meta.dir, "../../..")
  const environment = Object.fromEntries(
    ["PATH", "Path", "SystemRoot", "WINDIR", "HOME", "USERPROFILE"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]],
    ),
  )
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: source,
      env: environment,
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
    }).trim()
  if (git(["rev-parse", "HEAD"]) !== input.candidate || git(["status", "--porcelain", "--untracked-files=normal"]))
    throw new Error("billing-pilot-source-not-frozen")
  await mkdir(input.root)
  const workspace = path.join(input.root, "workspace")
  const profile = path.join(input.root, "profile")
  const chain = await prepare(workspace, "billing")
  await mkdir(path.join(profile, "config", "zaovra"), { recursive: true })
  await writeFile(path.join(profile, ".evaluation-profile"), "zaovra-memory-evaluation-v1\n", { flag: "wx" })
  const providerID = `evaluation-${input.family}`
  const config = {
    model: `${providerID}/${input.modelID}`,
    shell: "powershell",
    formatter: false,
    lsp: false,
    memory: { enabled: input.treatment === "B", taskSearch: false, index: { enabled: true } },
    agent: { build: { steps: 8 } },
    permission: { "*": "allow", external_directory: "deny", task: "deny", webfetch: "deny", websearch: "deny" },
    provider: {
      [providerID]: {
        npm: input.family === "gpt" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
        options: { baseURL: endpoint.toString(), apiKey: "{env:ZAOVRA_EVAL_API_KEY}", timeout: 120000 },
        models: {
          [input.modelID]: {
            family: input.family,
            tool_call: true,
            reasoning: true,
            limit: { context: 32000, output: 4096 },
          },
        },
      },
    },
  }
  await writeFile(path.join(profile, "config", "zaovra", "zaovra.json"), JSON.stringify(config), { flag: "wx" })
  const manifest = {
    version: 1,
    chain: chain.id,
    family: input.family,
    model: { id: input.modelID, providerID },
    variant: "default",
    treatment: input.treatment,
    candidate: input.candidate,
    endpointHash: createHash("sha256").update(endpoint.toString()).digest("hex"),
    configHash: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    promptsHash: createHash("sha256").update(JSON.stringify(chain.prompts)).digest("hex"),
    providerTurnAllowance: 8,
    contextLimit: 32000,
    outputLimit: 4096,
    stageDeadlineSeconds: 180,
    budget: { reserved: input.reserveTokens, status: "unknown", release: false },
    memoryNoteProfile: "unknown",
    taskSearch: false,
    tidy: false,
  }
  // Credentials stay only in the explicitly supplied child environment, never config or manifest.
  await writeFile(path.join(input.root, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" })
  const stages: Array<{
    stage: number
    status: "not-run" | "completed" | "failed"
    pass: boolean
    reason: string
    phase?: string
    category?: string
    evidence?: string[]
  }> = chain.prompts.map((_, index) => ({ stage: index + 1, status: "not-run", pass: false, reason: "not-run" }))
  let previousSessionID: string | undefined
  for (const [index, prompt] of chain.prompts.entries()) {
    const stage = path.join(input.root, `stage-${index + 1}`)
    let phase = "source-check"
    try {
      if (git(["rev-parse", "HEAD"]) !== input.candidate || git(["status", "--porcelain", "--untracked-files=normal"]))
        throw new Error("billing-pilot-source-not-frozen")
      phase = "host-transition"
      if (index === 3) await change(workspace, chain.id)
      phase = "session"
      const result = await runEvaluationSession({
        directory: workspace,
        profile,
        stage,
        model: manifest.model,
        prompt,
        seconds: manifest.stageDeadlineSeconds,
        providerEnvironment: input.environment,
        ...(index === 3 ? { poison: { chain: chain.id, sourceSessionID: previousSessionID! } } : {}),
      })
      phase = "session-evidence"
      await writeFile(path.join(stage, "session.json"), JSON.stringify(result, null, 2), { flag: "wx" })
      if (!result.observation.turn) throw new Error("missing-billing-pilot-turn")
      phase = "oracle"
      const grade = await gradeBilling({ directory: workspace, stage: index + 1, turn: result.observation.turn })
      phase = "grade-evidence"
      await writeFile(path.join(stage, "grade.json"), JSON.stringify(grade, null, 2), { flag: "wx" })
      stages[index] = { stage: index + 1, status: "completed", pass: grade.pass, reason: grade.reason }
      previousSessionID = result.admission.sessionID
    } catch (error) {
      // Preserve all earlier results. No new admission retries or artifact grading after a failed Session.
      const allowed = [
        "billing-pilot-source-not-frozen",
        "evaluation-session-not-completed",
        "evaluation-session-deadline",
        "evaluation-backend-ready-timeout",
        "evaluation-backend-ended-before-ready",
        "evaluation-history-incomplete",
        "missing-billing-pilot-turn",
      ]
      const reason =
        error instanceof Error && allowed.includes(error.message) ? error.message : "unclassified-stage-error"
      const evidence = (
        await Promise.all(
          ["incomplete.json", "backend.log", "session.json", "grade.json", "fixture.json"].map(
            async (name) =>
              await access(path.join(stage, name)).then(
                () => [`stage-${index + 1}/${name}`],
                () => [],
              ),
          ),
        )
      ).flat()
      stages[index] = {
        stage: index + 1,
        status: "failed",
        pass: false,
        phase,
        reason,
        evidence,
        category:
          reason === "evaluation-session-not-completed"
            ? "product-turn"
            : reason === "evaluation-session-deadline"
              ? "deadline-unresolved"
              : phase === "oracle"
                ? "oracle"
                : "infrastructure",
      }
      break
    }
  }
  const result = {
    ...manifest,
    stages,
    pass: stages.every((stage) => stage.status === "completed" && stage.pass),
    counts: {
      planned: stages.length,
      entered: stages.filter((stage) => stage.status !== "not-run").length,
      completed: stages.filter((stage) => stage.status === "completed").length,
      notRun: stages.filter((stage) => stage.status === "not-run").length,
    },
    usage: { status: "unknown", total: null, reserve: "retain" },
    completedAt: new Date().toISOString(),
  }
  await writeFile(path.join(input.root, "result.json"), JSON.stringify(result, null, 2), { flag: "wx" })
  return result
}
