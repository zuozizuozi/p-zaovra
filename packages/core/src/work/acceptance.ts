export * as WorkAcceptance from "./acceptance"

import { Work } from "@zaovra-ai/schema/work"
import { Effect } from "effect"
import { lstat, readlink } from "node:fs/promises"
import { ChildProcess } from "effect/unstable/process"
import path from "path"
import { FSUtil } from "../fs-util"
import { AppProcess } from "../process"
import { Hash } from "../util/hash"
import type { WorkPlanner } from "./planner"
import { WorkRole } from "./role"

export function criteria(goal: Work.GoalInfo, task: Work.TaskInfo) {
  return (
    task.acceptance?.criteria ?? goal.acceptanceCriteria.filter((criterion) => task.criteria.includes(criterion.id))
  )
}

/** Called only when admitting a new plan; stored legacy graphs keep their original contract. */
export function plan(goal: Work.GoalInfo, tasks: ReadonlyArray<WorkPlanner.ValidatedTask>) {
  const qa = WorkRole.get("qa", goal.roleContracts ?? WorkRole.contracts)
  if (!qa || qa.agentID !== "work-qa" || qa.workspaceAccess !== "read_only" || !qa.allowedIsolation.includes("shared"))
    throw new Error("Final acceptance requires the read-only work-qa role")
  const terminal = tasks.findLast(
    (task) => task.role === "qa" && !tasks.some((other) => other.dependsOn.includes(task.id)),
  )
  const business = tasks
    .filter((task) => task !== terminal)
    .map((task) => {
      const acceptance = local(task)
      const assigned = acceptance.criteria
      return {
        ...task,
        criteria: assigned.map((criterion) => criterion.id),
        acceptance,
      }
    })
  // An all-QA plan still needs a real business task; do not silently discard its scope.
  if (!business.length && terminal)
    return plan(
      goal,
      tasks.map((task) => ({ ...task, role: "explore" })),
    )
  if (business.length >= 24) throw new Error("Plan must leave room for final acceptance within the 24 Task limit")
  return [
    ...business,
    {
      id: terminal?.id ?? Work.TaskID.make(`task_${Hash.sha256(`${goal.id}:host-final-acceptance`).slice(0, 24)}`),
      title: "Final acceptance",
      instructions: `${terminal?.instructions ?? ""}\n\nVerify the completed Goal against its original acceptance criteria and the current artifacts. Read code and evidence; the host runs declared verifiers. Do not implement, edit files, or invent new requirements. Attribute failures to the responsible business taskID in each finding. The host routes repairs back to business Tasks.`,
      dependsOn: business.map((task) => task.id),
      role: "qa",
      isolation: "shared" as const,
      criteria: goal.acceptanceCriteria.map((criterion) => criterion.id),
      acceptance: { scope: "final" as const, criteria: goal.acceptanceCriteria },
    },
  ] satisfies ReadonlyArray<WorkPlanner.ValidatedTask>
}

export function local(task: {
  id: Work.TaskID
  instructions: string
  localAcceptance?: ReadonlyArray<string>
}): Work.TaskAcceptance {
  return {
    scope: "local",
    criteria: (task.localAcceptance?.length ? task.localAcceptance : [task.instructions]).map((description, index) => ({
      id: Work.CriterionID.make(`criterion_local_${Hash.sha256(`${task.id}:${index}:${description}`).slice(0, 24)}`),
      description,
      required: true,
      evidence: "review",
    })),
  }
}

export function valid(
  goal: ReadonlyArray<Work.Criterion>,
  task: Pick<Work.TaskInfo, "id" | "criteria" | "acceptance" | "role">,
) {
  if (!task.acceptance) return task.criteria.every((id) => goal.some((criterion) => criterion.id === id))
  const assigned = task.acceptance.criteria
  if (
    (task.acceptance.scope === "local" && !assigned.length) ||
    new Set(assigned.map((criterion) => criterion.id)).size !== assigned.length ||
    assigned.length !== task.criteria.length ||
    assigned.some((criterion) => !task.criteria.includes(criterion.id))
  )
    return false
  if (task.acceptance.scope === "final") return task.role === "qa" && JSON.stringify(assigned) === JSON.stringify(goal)
  return assigned.every(
    (criterion) =>
      criterion.required &&
      !criterion.verifier &&
      criterion.evidence === "review" &&
      criterion.id.startsWith("criterion_local_") &&
      !goal.some((global) => global.id === criterion.id),
  )
}

export function validGraph(goal: ReadonlyArray<Work.Criterion>, tasks: ReadonlyArray<Work.TaskInfo>) {
  if (!tasks.some((task) => task.acceptance)) return true
  const finals = tasks.filter((task) => task.acceptance?.scope === "final")
  return (
    finals.length === 1 &&
    tasks.every((task) => !!task.acceptance && valid(goal, task)) &&
    tasks.filter((task) => task !== finals[0]).every((task) => finals[0]!.dependsOn.includes(task.id)) &&
    new Set(tasks.flatMap((task) => task.criteria)).size ===
      tasks.reduce((count, task) => count + task.criteria.length, 0)
  )
}

/** Git receipts cover tracked and non-ignored untracked files. Non-Git workspaces only
 * exclude known cache directories; they cannot infer project-specific ignore rules.
 * Large assets use metadata (not content proof); unchanged size/mtime cannot detect an edit.
 */
export const fingerprint: (
  fs: FSUtil.Interface,
  proc: AppProcess.Interface,
  directory: string,
) => Effect.Effect<string | undefined> = Effect.fn("WorkAcceptance.fingerprint")(function* (
  fs: FSUtil.Interface,
  proc: AppProcess.Interface,
  directory: string,
) {
  const walk = (directory: string): Effect.Effect<string[], FSUtil.Error> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectoryEntries(directory)
      return (yield* Effect.forEach(
        entries.filter(
          (entry) =>
            !(
              entry.type === "directory" &&
              [".git", "node_modules", "__pycache__", ".pytest_cache", ".cache"].includes(entry.name)
            ),
        ),
        (entry) =>
          entry.type === "directory"
            ? walk(path.join(directory, entry.name))
            : Effect.succeed([path.join(directory, entry.name)]),
      )).flat()
    })
  return yield* Effect.gen(function* () {
    // A broken Git invocation must not silently fall back to different receipt semantics.
    const git = yield* fs.up({ targets: [".git"], start: directory })
    const files = git.length
      ? yield* proc
          .run(
            ChildProcess.make("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
              cwd: directory,
              stdin: "ignore",
              extendEnv: true,
            }),
          )
          .pipe(
            Effect.flatMap(AppProcess.requireSuccess),
            Effect.map((result) =>
              result.stdout
                .toString("utf8")
                .split("\0")
                .filter(Boolean)
                .map((file) => path.resolve(directory, file)),
            ),
          )
      : yield* walk(directory)
    const gitlinks = new Set(
      git.length
        ? (yield* proc
            .run(
              ChildProcess.make("git", ["ls-files", "--stage", "-z"], {
                cwd: directory,
                stdin: "ignore",
                extendEnv: true,
              }),
            )
            .pipe(Effect.flatMap(AppProcess.requireSuccess))).stdout
            .toString("utf8")
            .split("\0")
            .filter((entry) => entry.startsWith("160000 "))
            .map((entry) => path.resolve(directory, entry.slice(entry.indexOf("\t") + 1)))
        : [],
    )
    const receipts = yield* Effect.forEach([...new Set(files)].toSorted(), (file) =>
      Effect.gen(function* () {
        const info = yield* Effect.tryPromise(() =>
          lstat(file).catch((error: unknown) => {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
            throw error
          }),
        )
        if (gitlinks.has(file)) {
          if (!info?.isDirectory() || !(yield* fs.exists(path.join(file, ".git"))))
            return yield* Effect.fail(new Error(`Uninitialized or unsupported submodule: ${file}`))
          const head = yield* proc
            .run(ChildProcess.make("git", ["rev-parse", "HEAD"], { cwd: file, stdin: "ignore", extendEnv: true }))
            .pipe(Effect.flatMap(AppProcess.requireSuccess))
          const content = yield* fingerprint(fs, proc, file)
          if (!content) return yield* Effect.fail(new Error(`Cannot fingerprint submodule contents: ${file}`))
          return { path: file, digest: `gitlink:${head.stdout.toString("utf8").trim()}:${content}` }
        }
        if (!info) return { path: file, digest: "deleted" }
        if (info.isSymbolicLink())
          return { path: file, digest: `symlink:${yield* Effect.tryPromise(() => readlink(file))}` }
        if (!info.isFile()) return yield* Effect.fail(new Error(`Unsupported acceptance file type: ${file}`))
        const mode = info.mode & 0o111
        if (info.size > 64 * 1024 * 1024) {
          const mtime = info.mtime.getTime()
          return {
            path: file,
            digest: Number.isFinite(mtime) ? `metadata:${mode}:${info.size}:${mtime}` : undefined,
          }
        }
        const bytes = yield* fs.readFile(file)
        return { path: file, digest: `file:${mode}:${Hash.sha256(Buffer.from(bytes))}` }
      }),
    )
    return receipts.some((file) => !file.digest) ? undefined : Hash.sha256(JSON.stringify(receipts))
  }).pipe(
    Effect.catch((error) => Effect.logWarning("Acceptance fingerprint unavailable", error).pipe(Effect.as(undefined))),
  )
})
