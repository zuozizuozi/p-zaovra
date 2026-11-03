import { appendFile } from "node:fs/promises"

export function verifyBetaCI(input: unknown, sha: string, currentRun?: number) {
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    !input ||
    typeof input !== "object" ||
    !("workflow_runs" in input) ||
    !Array.isArray(input.workflow_runs)
  )
    throw new Error("Invalid CI inventory")
  const runs = input.workflow_runs as {
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
  }[]
  for (const name of ["test", "typecheck"]) {
    const latest = runs
      .filter(
        (run) =>
          run.name === name &&
          run.head_sha === sha &&
          run.head_branch === "main" &&
          run.event === "push" &&
          run.repository?.full_name === "zuozizuozi/p-zaovra",
      )
      .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0]
    if (!latest || latest.status !== "completed" || latest.conclusion !== "success")
      throw new Error("Exact main " + name + " CI has not passed")
  }
  return runs.some(
    (run) =>
      run.name === "windows-beta" &&
      run.event === "workflow_run" &&
      run.head_sha === sha &&
      run.repository?.full_name === "zuozizuozi/p-zaovra" &&
      run.id !== currentRun &&
      run.status === "completed" &&
      run.conclusion === "success",
  )
}
if (import.meta.main) {
  if (process.env.EVENT_NAME === "workflow_run" && process.env.WORKFLOW_SHA !== process.argv[3])
    throw new Error("The automatic build must use the workflow source SHA")
  const alreadyBuilt = verifyBetaCI(await Bun.file(process.argv[2]).json(), process.argv[3], Number(process.argv[4]))
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, "build=" + !alreadyBuilt + "\n")
  console.log("Exact main test and typecheck both passed")
}
