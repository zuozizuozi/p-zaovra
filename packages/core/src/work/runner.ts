export * as WorkRunner from "./runner"

import { Work } from "@zaovra-ai/schema/work"
import { DurableEventManifest } from "@zaovra-ai/schema/durable-event-manifest"
import { Cause, Context, DateTime, Effect, Exit, Layer } from "effect"
import path from "path"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { Git } from "../git"
import { Global } from "../global"
import { Location } from "../location"
import { LocationServiceMap } from "../location-service-map"
import { ProjectCopy } from "../project/copy"
import { ProjectDirectories } from "../project/directories"
import { AbsolutePath } from "../schema"
import { SessionV2 } from "../session"
import { SessionMessage } from "../session/message"
import { WorkArtifact } from "./artifact"
import { WorkAccessFailure } from "./access-failure"
import { WorkArchitect } from "./architect"
import { WorkHandoff } from "./handoff"
import { WorkIsolation } from "./isolation"
import { WorkPlanner } from "./planner"
import { WorkReviewer } from "./reviewer"
import { WorkRemoteJob } from "./remote-job"
import { WorkRole } from "./role"
import { WorkLease } from "./lease"
import { WorkStateMachine } from "./state-machine"
import { WorkStore } from "./store"
import { WorkVerifier } from "./verifier"

export interface Interface {
  readonly run: (input: { readonly goalID: Work.GoalID; readonly force: boolean }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkRunner") {}

const DEFAULT_MAX_ATTEMPTS_PER_TASK = 8
const DEFAULT_MAX_REPAIR_ATTEMPTS = 3

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const sessions = yield* SessionV2.Service
    const store = yield* WorkStore.Service
    const verifier = yield* WorkVerifier.Service
    const reviewer = yield* WorkReviewer.Service
    const planner = yield* WorkPlanner.Service
    const architect = yield* WorkArchitect.Service
    const artifacts = yield* WorkArtifact.Service
    const remoteJobs = yield* WorkRemoteJob.Service
    const isolation = yield* WorkIsolation.Service
    const leases = yield* WorkLease.Service
    const git = yield* Git.Service
    const locations = yield* LocationServiceMap.Service
    const projectDirectories = yield* ProjectDirectories.Service
    const db = (yield* Database.Service).db
    const goalTransitions = KeyedMutex.makeUnsafe<Work.GoalID>()

    const blockGoal = Effect.fn("WorkRunner.blockGoal")(
      (goalID: Work.GoalID, reason: string, timestamp: DateTime.Utc) =>
        goalTransitions.withLock(goalID)(
          Effect.gen(function* () {
            const goal = yield* store.getGoal(goalID)
            if (!goal || goal.status === "blocked" || WorkStateMachine.isGoalTerminal(goal.status)) return
            yield* events.publish(Work.Event.GoalBlocked, { goalID, reason, timestamp })
          }),
        ),
    )

    const dependencyHandoffs = Effect.fn("WorkRunner.dependencyHandoffs")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
    ) {
      const mailbox = yield* store.mailbox(task.id)
      const results = yield* Effect.forEach(task.dependsOn, (taskID) =>
        Effect.gen(function* () {
          const dependency = yield* store.getTask(taskID)
          if (!dependency) return ""
          const handoff = mailbox.find((item) => item.taskID === taskID)
          if (!handoff) return `Dependency ${dependency.title} completed without a durable Handoff.`
          const items = WorkRole.acceptsHandoff(task.role, handoff, goal.roleContracts ?? WorkRole.contracts)
          return [
            `Dependency ${dependency.title} (${dependency.id}), produced by ${handoff.producer}:`,
            `Summary: ${handoff.summary}`,
            ...items.map(
              (item) =>
                `- ${item.kind}${item.key ? `:${item.key}` : ""}: ${item.text}${item.reference ? ` [${item.reference}]` : ""}`,
            ),
            items.length === 0 ? `No Handoff items are admitted by the ${task.role} Role Contract.` : "",
            handoff.evidenceIDs.length > 0 ? `Evidence: ${handoff.evidenceIDs.join(", ")}` : "",
            `Handoff digest: ${handoff.digest}`,
          ]
            .filter(Boolean)
            .join("\n")
        }),
      )
      return results.filter(Boolean).join("\n\n").slice(0, 32_000)
    })

    const ensureHandoff = Effect.fn("WorkRunner.ensureHandoff")(function* (goal: Work.GoalInfo, task: Work.TaskInfo) {
      if (task.status !== "completed" || task.role === "work-planner" || task.role === "work-architect") return
      if (yield* store.handoff(task.id)) return
      const attempt = (yield* store.attempts(task.id))
        .filter(
          (candidate) =>
            candidate.status === "succeeded" && (candidate.kind === "execute" || candidate.kind === "repair"),
        )
        .at(-1)
      if (!attempt) return
      const messages = attempt.sessionID
        ? yield* sessions.messages({ sessionID: attempt.sessionID, limit: 20, order: "desc" })
        : []
      const response = messages.find((message) => message.type === "assistant")
      const remoteResponse = (yield* remoteAgentJob(goal, task, attempt.id))?.result
      const text =
        response?.type === "assistant"
          ? response.content
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("\n")
          : remoteResponse?.type === "agent"
            ? (remoteResponse.finalResponse ?? "")
            : ""
      const output = WorkRole.normalizeHandoff(
        task.role,
        WorkHandoff.parse(text),
        goal.roleContracts ?? WorkRole.contracts,
      )
      const latest = new Map(
        (yield* store.evaluations(task.id))
          .toSorted((a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt))
          .map((evaluation) => [evaluation.criterionID, evaluation]),
      )
      const evidenceIDs = Array.from(
        new Set(
          Array.from(latest.values())
            .filter((evaluation) => evaluation.verdict === "pass")
            .flatMap((evaluation) => evaluation.evidenceIDs),
        ),
      )
      const timestamp = yield* DateTime.now
      const recipients = (yield* store.tasks(goal.id))
        .filter((candidate) => candidate.dependsOn.includes(task.id))
        .map((candidate) => candidate.id)
      yield* events.publish(Work.Event.TaskHandoffRecorded, {
        goalID: goal.id,
        timestamp,
        info: Work.HandoffInfo.make({
          id: WorkHandoff.id(task.id),
          goalID: goal.id,
          taskID: task.id,
          attemptID: attempt.id,
          producer: task.role,
          summary: output.summary,
          items: output.items,
          evidenceIDs,
          recipients,
          digest: WorkHandoff.digest(output, evidenceIDs),
          createdAt: timestamp,
        }),
      })
    })

    const ensureRoutes = Effect.fn("WorkRunner.ensureRoutes")(function* (
      goal: Work.GoalInfo,
      tasks: ReadonlyArray<Work.TaskInfo>,
    ) {
      for (const handoff of yield* store.handoffs(goal.id)) {
        const missing = tasks
          .filter((task) => task.dependsOn.includes(handoff.taskID) && !handoff.recipients.includes(task.id))
          .map((task) => task.id)
        if (missing.length === 0) continue
        yield* events.publish(Work.Event.TaskHandoffRouted, {
          goalID: goal.id,
          handoffID: handoff.id,
          recipientTaskIDs: missing,
          timestamp: yield* DateTime.now,
        })
      }
    })

    const remoteAgentJob = Effect.fn("WorkRunner.remoteAgentJob")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      attemptID?: Work.AttemptID,
    ) {
      if (!goal.workerID) return undefined
      const attemptIDs = new Set(
        (yield* store.attempts(task.id))
          .filter((attempt) => attempt.kind === "execute" || attempt.kind === "repair")
          .map((attempt) => attempt.id),
      )
      return (yield* remoteJobs.list(goal.id)).findLast(
        (job) =>
          job.operation.type === "agent" &&
          job.status === "completed" &&
          attemptIDs.has(job.attemptID) &&
          (attemptID === undefined || job.attemptID === attemptID),
      )
    })

    const remoteAgentOperation = Effect.fn("WorkRunner.remoteAgentOperation")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      attempt: Work.AttemptInfo,
      prompt: string,
    ) {
      if (!goal.workerID || !attempt.sessionID) return undefined
      const location = task.location ?? goal.location
      const repository = yield* git.repo.discover(location.directory)
      if (!repository) return undefined
      const baseRevision = yield* git.history.head(repository)
      if (!baseRevision || !/^[a-f0-9]{40,64}$/.test(baseRevision)) return undefined
      const session = yield* sessions.get(attempt.sessionID).pipe(Effect.orDie)
      const previous = (yield* remoteJobs.list(goal.id)).findLast(
        (job) =>
          job.attemptID !== attempt.id &&
          job.status === "completed" &&
          job.operation.type === "agent" &&
          job.operation.location.directory === location.directory &&
          job.operation.location.workspaceID === location.workspaceID &&
          job.result?.type === "agent" &&
          job.result.workspaceDigest !== undefined,
      )
      const previousResult = previous?.result?.type === "agent" ? previous.result : undefined
      return Work.WorkerAgentOperation.make({
        type: "agent",
        sessionID: attempt.sessionID,
        agent: session.agent ?? AgentV2.defaultID,
        prompt,
        location,
        artifactCapture: {
          type: "git_diff",
          baseRevision,
          maxBytes: WorkRemoteJob.maxArtifactBytes,
          ...(previousResult?.workspaceDigest && previousResult.baseRevision === baseRevision
            ? { startDigest: previousResult.workspaceDigest }
            : {}),
        },
      })
    })

    const dispatchRemoteAgent = Effect.fn("WorkRunner.dispatchRemoteAgent")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      attempt: Work.AttemptInfo,
      prompt: string,
    ) {
      const operation = yield* remoteAgentOperation(goal, task, attempt, prompt)
      if (!operation) return undefined
      const result = yield* remoteJobs.dispatch({
        workerID: goal.workerID,
        goalID: goal.id,
        attemptID: attempt.id,
        criterionID: WorkRemoteJob.agentCriterionID(attempt.id),
        operation,
      })
      if (!result) return undefined
      if (result.type !== "agent") return yield* Effect.die("Remote Agent Job returned a mismatched result type")
      return result
    })

    const remoteAgentText = Effect.fn("WorkRunner.remoteAgentText")(function* (
      result: Work.WorkerAgentResult | undefined,
    ) {
      if (!result) return undefined
      if (result.status === "interrupted") return yield* Effect.interrupt
      if (result.status !== "succeeded" || result.artifactError || result.finalResponse === undefined)
        return yield* Effect.fail(
          new Error(result.artifactError ?? result.error ?? `Remote Agent ended with ${result.status}`),
        )
      return result.finalResponse
    })

    const execute = Effect.fn("WorkRunner.execute")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      attempt: Work.AttemptInfo,
      claim: WorkLease.Claim,
    ) {
      const fence = claim.fence
      const ownerID = claim.ownerID
      const started = yield* DateTime.now
      yield* leases.assert(claim)
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID: goal.id,
        attemptID: attempt.id,
        ownerID,
        fence,
        timestamp: started,
      })

      const priorEvaluations = yield* store.evaluations(task.id)
      const dependencies = yield* dependencyHandoffs(goal, task)
      const prompt = instructions(goal, task, priorEvaluations, dependencies)
      const remote = yield* dispatchRemoteAgent(goal, task, attempt, prompt)
      if (remote) {
        const timestamp = yield* DateTime.now
        yield* leases.assert(claim)
        const successful = remote.status === "succeeded" && !remote.artifactError
        yield* events.publish(Work.Event.AttemptSettled, {
          goalID: goal.id,
          attemptID: attempt.id,
          status: successful
            ? "succeeded"
            : remote.status === "interrupted"
              ? "interrupted"
              : remote.status === "unknown"
                ? "unknown"
                : "failed",
          ownerID,
          fence,
          ...(successful
            ? {}
            : {
                failure: {
                  kind:
                    remote.status === "interrupted" ? "interrupted" : remote.status === "unknown" ? "unknown" : "error",
                  message: remote.artifactError ?? remote.error ?? `Remote Agent ended with ${remote.status}`,
                  retryable: remote.status === "failed" && !remote.artifactError,
                },
              }),
          timestamp,
        })
        if (successful) {
          yield* events.publish(Work.Event.TaskVerificationStarted, {
            goalID: goal.id,
            taskID: task.id,
            status: "verifying",
            timestamp,
          })
          return
        }
        if (remote.status === "interrupted") return
        if (remote.status === "failed" && !remote.artifactError) {
          if (retryAvailable(goal, task)) return
          yield* exhaustBudget(goal, task, "Retryable Remote Agent failure exhausted the Attempt budget")
          return
        }
        const reason = remote.status === "unknown" ? "Remote Agent outcome is unknown" : "Remote Agent Session failed"
        yield* events.publish(Work.Event.TaskBlocked, {
          goalID: goal.id,
          taskID: task.id,
          status: "blocked",
          reason,
          timestamp,
        })
        yield* blockGoal(goal.id, reason, timestamp)
        return
      }
      const exit = yield* Effect.uninterruptibleMask((restore) =>
        restore(
          sessions
            .prompt({
              id: promptID(attempt.id),
              sessionID: attempt.sessionID!,
              prompt: { text: prompt },
              resume: false,
            })
            .pipe(Effect.andThen(sessions.resume(attempt.sessionID!))),
        ).pipe(Effect.exit),
      )
      const timestamp = yield* DateTime.now
      yield* leases.assert(claim)
      if (Exit.isSuccess(exit)) {
        yield* events.publish(Work.Event.AttemptSettled, {
          goalID: goal.id,
          attemptID: attempt.id,
          status: "succeeded",
          ownerID,
          fence,
          timestamp,
        })
        yield* events.publish(Work.Event.TaskVerificationStarted, {
          goalID: goal.id,
          taskID: task.id,
          status: "verifying",
          timestamp,
        })
        return
      }

      const interrupted = Cause.hasInterrupts(exit.cause)
      yield* events.publish(Work.Event.AttemptSettled, {
        goalID: goal.id,
        attemptID: attempt.id,
        status: interrupted ? "interrupted" : "failed",
        ownerID,
        fence,
        failure: {
          kind: interrupted ? "interrupted" : "error",
          message: interrupted ? "Work execution interrupted" : errorText(Cause.squash(exit.cause)),
          retryable: !interrupted,
        },
        timestamp,
      })
      if (interrupted) return
      if (retryAvailable(goal, task)) return
      yield* exhaustBudget(goal, task, "Retryable Executor failure exhausted the Attempt budget")
      return
    })

    const finishGoal = Effect.fn("WorkRunner.finishGoal")(function* (goal: Work.GoalInfo, timestamp: DateTime.Utc) {
      const tasks = yield* store.tasks(goal.id)
      if (!tasks.every((task) => task.status === "completed" || task.status === "superseded")) return false
      const evaluations = (yield* Effect.forEach(
        tasks.filter((task) => task.status === "completed"),
        (task) => store.evaluations(task.id),
      )).flat()
      const latest = new Map(
        evaluations
          .toSorted((a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt))
          .map((evaluation) => [evaluation.criterionID, evaluation]),
      )
      if (
        goal.acceptanceCriteria
          .filter((criterion) => criterion.required)
          .every((criterion) => latest.get(criterion.id)?.verdict === "pass")
      ) {
        yield* events.publish(Work.Event.GoalCompleted, { goalID: goal.id, timestamp })
        return true
      }
      yield* blockGoal(goal.id, "All Tasks completed without satisfying every required criterion", timestamp)
      return true
    })

    const mergeConflict = Effect.fn("WorkRunner.mergeConflict")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      digest: string,
      reason: string,
    ) {
      const timestamp = yield* DateTime.now
      yield* events.publish(Work.Event.TaskMergeConflicted, {
        goalID: goal.id,
        taskID: task.id,
        status: "blocked",
        digest,
        reason,
        timestamp,
      })
      yield* blockGoal(goal.id, reason, timestamp)
      return false
    })

    const merge = Effect.fn("WorkRunner.merge")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      claim: WorkLease.Claim,
    ) {
      let cursor = -1
      let prepared: Work.Event.DurableEvent | undefined
      while (true) {
        const history = yield* EventV2.readAggregate(db, {
          aggregateID: goal.id,
          after: cursor,
          limit: 500,
          manifest: DurableEventManifest.WorkDurable,
        })
        prepared =
          history.events.findLast(
            (event) => event.type === Work.Event.TaskMergeStarted.type && event.data.taskID === task.id,
          ) ?? prepared
        if (!history.hasMore) break
        const next = history.events.at(-1)?.durable?.seq
        if (next === undefined) break
        cursor = next
      }
      if (!prepared || prepared.type !== Work.Event.TaskMergeStarted.type)
        return yield* mergeConflict(goal, task, hash("missing-merge-input"), "Durable merge input is missing")
      if ((prepared.data.changes === undefined) === (prepared.data.artifact === undefined))
        return yield* mergeConflict(goal, task, prepared.data.digest, "Durable merge input is ambiguous")
      const resolved = yield* (
        prepared.data.artifact ? artifacts.get(prepared.data.artifact) : Effect.succeed(prepared.data.changes!)
      ).pipe(Effect.exit)
      if (Exit.isFailure(resolved))
        return yield* mergeConflict(goal, task, prepared.data.digest, errorText(Cause.squash(resolved.cause)))
      if (hash(resolved.value) !== prepared.data.digest)
        return yield* mergeConflict(goal, task, prepared.data.digest, "Durable merge input digest does not match")
      const changes = Git.ChangeSet.make(resolved.value)
      if (changes.length > 0) {
        const applied = yield* Effect.gen(function* () {
          const repository = yield* git.repo.discover(goal.location.directory)
          if (!repository)
            return yield* new Git.PatchError({
              operation: "apply",
              directory: goal.location.directory,
              message: "Goal workspace is not a Git repository",
            })
          if (yield* git.change.check({ repository, path: goal.location.directory, changes })) {
            yield* git.change.apply({ repository, path: goal.location.directory, changes })
            return undefined
          }
          if (yield* git.change.check({ repository, path: goal.location.directory, changes, reverse: true }))
            return undefined
          return yield* new Git.PatchError({
            operation: "apply",
            directory: goal.location.directory,
            message: "Isolated Task changes conflict with the Goal workspace",
          })
        }).pipe(Effect.exit)
        if (Exit.isFailure(applied)) {
          yield* isolation.release(goal, task)
          return yield* mergeConflict(goal, task, prepared.data.digest, errorText(Cause.squash(applied.cause)))
        }
      }
      yield* leases.assert(claim)
      const timestamp = yield* DateTime.now
      yield* isolation.release(goal, task)
      yield* events.publish(Work.Event.TaskMerged, {
        goalID: goal.id,
        taskID: task.id,
        status: "completed",
        digest: prepared.data.digest,
        timestamp,
      })
      return true
    })

    const synchronizeRemoteAgent = Effect.fn("WorkRunner.synchronizeRemoteAgent")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
    ) {
      const job = yield* remoteAgentJob(goal, task)
      if (!job) return undefined
      const result = job.result
      if (!result || result.type !== "agent" || result.status !== "succeeded")
        return "Latest remote Agent Job has no successful result"
      if (result.artifactError || !result.baseRevision || !result.workspaceDigest)
        return result.artifactError ?? "Latest remote Agent Job has no verified workspace snapshot"
      const location = task.location ?? goal.location
      const repository = yield* git.repo.discover(location.directory)
      if (!repository) return "Controller workspace is not a Git repository"
      const baseRevision = yield* git.history.head(repository)
      if (baseRevision !== result.baseRevision)
        return `Controller workspace revision ${baseRevision ?? "unknown"} does not match remote revision ${result.baseRevision}`
      const artifact = result.artifacts?.[0]
      const changes = artifact ? yield* artifacts.get(artifact) : ""
      if (hash(changes) !== result.workspaceDigest) return "Remote Agent workspace artifact digest does not match"
      const current = yield* git.change.capture({ repository, path: location.directory })
      if (hash(current) === result.workspaceDigest) return undefined
      if (current.length > 0)
        return "Controller workspace changed while the remote Agent was running; refusing to overwrite local work"
      if (changes.length === 0) return undefined
      const patch = Git.ChangeSet.make(changes)
      if (!(yield* git.change.check({ repository, path: location.directory, changes: patch })))
        return "Remote Agent workspace artifact does not apply to the controller workspace"
      yield* git.change.apply({ repository, path: location.directory, changes: patch })
      return undefined
    })

    const completeTask = Effect.fn("WorkRunner.completeTask")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      claim: WorkLease.Claim,
    ) {
      const synchronization = yield* synchronizeRemoteAgent(goal, task).pipe(Effect.exit)
      const synchronizationError = Exit.isFailure(synchronization)
        ? errorText(Cause.squash(synchronization.cause))
        : synchronization.value
      if (synchronizationError) {
        const timestamp = yield* DateTime.now
        yield* events.publish(Work.Event.TaskBlocked, {
          goalID: goal.id,
          taskID: task.id,
          status: "blocked",
          reason: synchronizationError,
          timestamp,
        })
        yield* blockGoal(goal.id, synchronizationError, timestamp)
        return false
      }
      if (!task.location || task.location.directory === goal.location.directory) {
        const timestamp = yield* DateTime.now
        yield* events.publish(Work.Event.TaskCompleted, {
          goalID: goal.id,
          taskID: task.id,
          status: "completed",
          timestamp,
        })
        return true
      }
      const captured = yield* Effect.gen(function* () {
        const repository = yield* git.repo.discover(task.location!.directory)
        if (!repository)
          return yield* new Git.PatchError({
            operation: "capture",
            directory: task.location!.directory,
            message: "Isolated Task workspace is not a Git repository",
          })
        return yield* git.change.capture({ repository, path: task.location!.directory })
      }).pipe(Effect.exit)
      if (Exit.isFailure(captured))
        return yield* mergeConflict(goal, task, hash("capture-failed"), errorText(Cause.squash(captured.cause)))
      const digest = hash(captured.value)
      const bytes = new TextEncoder().encode(captured.value).byteLength
      if (bytes > 64 * 1024 * 1024)
        return yield* mergeConflict(goal, task, digest, "Isolated Task change set exceeds the 64 MiB artifact limit")
      const stored = yield* (
        bytes > 64 * 1024
          ? artifacts
              .put(captured.value)
              .pipe(
                Effect.tap((artifact) =>
                  artifacts.retain(artifact, { type: "task-merge", id: `${goal.id}:${task.id}` }),
                ),
              )
          : Effect.succeed(undefined)
      ).pipe(Effect.exit)
      if (Exit.isFailure(stored))
        return yield* mergeConflict(
          goal,
          task,
          digest,
          `Unable to persist merge artifact: ${errorText(Cause.squash(stored.cause))}`,
        )
      yield* leases.assert(claim)
      yield* events.publish(Work.Event.TaskMergeStarted, {
        goalID: goal.id,
        taskID: task.id,
        status: "merging",
        source: task.location.directory,
        destination: goal.location.directory,
        changes: stored.value ? undefined : captured.value,
        artifact: stored.value,
        digest,
        timestamp: yield* DateTime.now,
      })
      const merging = yield* store.getTask(task.id)
      if (!merging) return yield* Effect.die(`Merging Task not projected: ${task.id}`)
      return yield* merge(goal, merging, claim)
    })

    const noProgress = Effect.fn("WorkRunner.noProgress")(function* (
      taskID: Work.TaskID,
      criterionID: Work.CriterionID,
    ) {
      const failures = (yield* store.evaluations(taskID)).filter(
        (evaluation) => evaluation.criterionID === criterionID && evaluation.verdict === "fail",
      )
      if (failures.length < 2) return false
      return failureSignature(failures.at(-1)!) === failureSignature(failures.at(-2)!)
    })

    const scheduleReplan = Effect.fn("WorkRunner.scheduleReplan")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      reason: string,
    ) {
      if (goal.budget?.maxReplans === undefined) return false
      const tasks = yield* store.tasks(goal.id)
      if (tasks.length > 126) return false
      const architects = tasks.filter((candidate) => candidate.role === "work-architect")
      if (architects.length >= goal.budget.maxReplans) return false
      if (architects.some((candidate) => !WorkStateMachine.isTaskTerminal(candidate.status))) return false
      const timestamp = yield* DateTime.now
      const info = Work.TaskInfo.make({
        id: Work.TaskID.make(`task_${hash(`${goal.id}:architect:${architects.length + 1}:${task.id}`).slice(0, 24)}`),
        goalID: goal.id,
        title: `Architect recovery for ${task.title}`,
        instructions: `${reason}. Replan around blocked Task ${task.id}.`,
        dependsOn: [],
        role: "work-architect",
        status: "pending",
        criteria: [],
        attemptCount: 0,
        time: { created: timestamp, updated: timestamp },
        revision: 0,
      })
      yield* events.publish(Work.Event.GoalReplanRequested, {
        goalID: goal.id,
        reason,
        info,
        timestamp,
      })
      return true
    })

    const verify = Effect.fn("WorkRunner.verify")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      attempt: Work.AttemptInfo,
      claim: WorkLease.Claim,
    ) {
      const criteria = goal.acceptanceCriteria.filter((criterion) => task.criteria.includes(criterion.id))
      for (const criterion of criteria.filter((criterion) => criterion.verifier !== undefined)) {
        const current = yield* store.evaluations(task.id)
        if (
          current.some((evaluation) => evaluation.attemptID === attempt.id && evaluation.criterionID === criterion.id)
        )
          continue
        const input = { goal, task, attempt, criterion }
        const recorded = (yield* store.evidence(task.id)).find((evidence) => evidence.id === WorkVerifier.id(input))
        const result = recorded
          ? { evidence: recorded, evaluation: yield* verifier.evaluateEvidence(input, recorded) }
          : yield* verifier.evaluate(input)
        if (!recorded)
          yield* events.publish(Work.Event.EvidenceRecorded, {
            goalID: goal.id,
            info: result.evidence,
            timestamp: result.evidence.createdAt,
          })
        if (!(yield* store.evaluations(task.id)).some((evaluation) => evaluation.id === result.evaluation.id))
          yield* events.publish(Work.Event.EvaluationRecorded, {
            goalID: goal.id,
            info: result.evaluation,
            timestamp: result.evaluation.createdAt,
          })
      }

      const evaluations = (yield* store.evaluations(task.id)).filter(
        (evaluation) => evaluation.attemptID === attempt.id,
      )
      const latest = new Map(evaluations.map((evaluation) => [evaluation.criterionID, evaluation]))
      const required = criteria.filter((criterion) => criterion.required)
      const blocked = required.find((criterion) => latest.get(criterion.id)?.verdict === "blocked")
      if (blocked) {
        const timestamp = yield* DateTime.now
        yield* events.publish(Work.Event.TaskBlocked, {
          goalID: goal.id,
          taskID: task.id,
          status: "blocked",
          reason: `Verifier blocked criterion ${blocked.id}`,
          timestamp,
        })
        if (yield* scheduleReplan(goal, task, `Verifier blocked criterion ${blocked.id}`)) return true
        yield* blockGoal(goal.id, `Verifier blocked criterion ${blocked.id}`, timestamp)
        return false
      }

      const failed = required.find((criterion) => latest.get(criterion.id)?.verdict === "fail")
      if (failed) {
        const evaluation = latest.get(failed.id)!
        if (!evaluation.allowsRepair || evaluation.findings.length === 0) {
          const timestamp = yield* DateTime.now
          const reason = `Verifier failure for ${failed.id} is not eligible for automatic repair`
          yield* events.publish(Work.Event.TaskBlocked, {
            goalID: goal.id,
            taskID: task.id,
            status: "blocked",
            reason,
            timestamp,
          })
          yield* blockGoal(goal.id, reason, timestamp)
          return false
        }
        if (!repairAvailable(goal, task)) {
          yield* exhaustBudget(goal, task, "Repair budget exhausted")
          return false
        }
        if (yield* noProgress(task.id, failed.id)) {
          const timestamp = yield* DateTime.now
          yield* events.publish(Work.Event.TaskBlocked, {
            goalID: goal.id,
            taskID: task.id,
            status: "blocked",
            reason: `No progress after repeated verifier failure for ${failed.id}`,
            timestamp,
          })
          if (yield* scheduleReplan(goal, task, `No progress after repeated verifier failure for ${failed.id}`))
            return true
          yield* blockGoal(goal.id, `No progress after repeated verifier failure for ${failed.id}`, timestamp)
          return false
        }
        yield* events.publish(Work.Event.TaskReworkRequested, {
          goalID: goal.id,
          taskID: task.id,
          status: "rework",
          reason: `Verifier failed criterion ${failed.id}`,
          timestamp: yield* DateTime.now,
        })
        return true
      }

      if (required.length > 0) {
        yield* events.publish(Work.Event.TaskReviewStarted, {
          goalID: goal.id,
          taskID: task.id,
          status: "reviewing",
          timestamp: yield* DateTime.now,
        })
        return true
      }

      return yield* completeTask(goal, task, claim)
    })

    const settleReview = Effect.fn("WorkRunner.settleReview")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      attempt: Work.AttemptInfo,
      criteria: ReadonlyArray<Work.Criterion>,
      claim: WorkLease.Claim,
    ) {
      const evaluations = (yield* store.evaluations(task.id)).filter(
        (evaluation) => evaluation.attemptID === attempt.id,
      )
      const latest = new Map(evaluations.map((evaluation) => [evaluation.criterionID, evaluation]))
      const blocked = criteria.find((criterion) => latest.get(criterion.id)?.verdict === "blocked")
      if (blocked) {
        const timestamp = yield* DateTime.now
        yield* events.publish(Work.Event.TaskBlocked, {
          goalID: goal.id,
          taskID: task.id,
          status: "blocked",
          reason: `Reviewer blocked criterion ${blocked.id}`,
          timestamp,
        })
        if (yield* scheduleReplan(goal, task, `Reviewer blocked criterion ${blocked.id}`)) return true
        yield* blockGoal(goal.id, `Reviewer blocked criterion ${blocked.id}`, timestamp)
        return false
      }
      const failed = criteria.find((criterion) => latest.get(criterion.id)?.verdict === "fail")
      if (failed) {
        const evaluation = latest.get(failed.id)!
        if (!evaluation.allowsRepair || evaluation.findings.length === 0) {
          const timestamp = yield* DateTime.now
          const reason = `Reviewer failure for ${failed.id} is not eligible for automatic repair`
          yield* events.publish(Work.Event.TaskBlocked, {
            goalID: goal.id,
            taskID: task.id,
            status: "blocked",
            reason,
            timestamp,
          })
          yield* blockGoal(goal.id, reason, timestamp)
          return false
        }
        if (!repairAvailable(goal, task)) {
          yield* exhaustBudget(goal, task, "Repair budget exhausted")
          return false
        }
        if (yield* noProgress(task.id, failed.id)) {
          const timestamp = yield* DateTime.now
          yield* events.publish(Work.Event.TaskBlocked, {
            goalID: goal.id,
            taskID: task.id,
            status: "blocked",
            reason: `No progress after repeated reviewer failure for ${failed.id}`,
            timestamp,
          })
          if (yield* scheduleReplan(goal, task, `No progress after repeated reviewer failure for ${failed.id}`))
            return true
          yield* blockGoal(goal.id, `No progress after repeated reviewer failure for ${failed.id}`, timestamp)
          return false
        }
        yield* events.publish(Work.Event.TaskReworkRequested, {
          goalID: goal.id,
          taskID: task.id,
          status: "rework",
          reason: `Reviewer failed criterion ${failed.id}`,
          timestamp: yield* DateTime.now,
        })
        return true
      }
      if (criteria.some((criterion) => latest.get(criterion.id)?.verdict !== "pass")) return false
      return yield* completeTask(goal, task, claim)
    })

    const executeReview = Effect.fn("WorkRunner.executeReview")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      attempt: Work.AttemptInfo,
      criteria: ReadonlyArray<Work.Criterion>,
      claim: WorkLease.Claim,
    ) {
      const fence = claim.fence
      const ownerID = claim.ownerID
      yield* leases.assert(claim)
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID: goal.id,
        attemptID: attempt.id,
        ownerID,
        fence,
        timestamp: yield* DateTime.now,
      })
      const evidence = yield* store.evidence(task.id)
      const handoffs = yield* store.mailbox(task.id)
      const input = { goal, task, attempt, criteria, evidence, handoffs }
      const exit = yield* Effect.uninterruptibleMask((restore) =>
        restore(
          dispatchRemoteAgent(goal, task, attempt, WorkReviewer.prompt(input)).pipe(
            Effect.flatMap(remoteAgentText),
            Effect.flatMap((text) => (text === undefined ? reviewer.run(input) : WorkReviewer.parse(text))),
          ),
        ).pipe(Effect.exit),
      )
      const timestamp = yield* DateTime.now
      yield* leases.assert(claim)
      if (Exit.isFailure(exit)) {
        const interrupted = Cause.hasInterrupts(exit.cause)
        yield* events.publish(Work.Event.AttemptSettled, {
          goalID: goal.id,
          attemptID: attempt.id,
          status: interrupted ? "interrupted" : "failed",
          ownerID,
          fence,
          failure: {
            kind: interrupted ? "interrupted" : "error",
            message: interrupted ? "Review execution interrupted" : errorText(Cause.squash(exit.cause)),
            retryable: false,
          },
          timestamp,
        })
        if (interrupted) return false
        yield* events.publish(Work.Event.TaskBlocked, {
          goalID: goal.id,
          taskID: task.id,
          status: "blocked",
          reason: "Reviewer did not produce valid structured output",
          timestamp,
        })
        yield* blockGoal(goal.id, "Reviewer did not produce valid structured output", timestamp)
        return false
      }

      const output = exit.value
      const requested = new Set(criteria.map((criterion) => criterion.id))
      if (
        output.criteria.length !== requested.size ||
        new Set(output.criteria.map((criterion) => criterion.criterionID)).size !== output.criteria.length ||
        output.criteria.some((criterion) => !requested.has(criterion.criterionID))
      ) {
        yield* events.publish(Work.Event.AttemptSettled, {
          goalID: goal.id,
          attemptID: attempt.id,
          status: "failed",
          ownerID,
          fence,
          failure: { kind: "error", message: "Reviewer criterion coverage is invalid", retryable: false },
          timestamp,
        })
        yield* events.publish(Work.Event.TaskBlocked, {
          goalID: goal.id,
          taskID: task.id,
          status: "blocked",
          reason: "Reviewer criterion coverage is invalid",
          timestamp,
        })
        yield* blockGoal(goal.id, "Reviewer criterion coverage is invalid", timestamp)
        return false
      }

      const evidenceID = WorkReviewer.evidenceID(attempt.id)
      if (!(yield* store.evidence(task.id)).some((evidence) => evidence.id === evidenceID))
        yield* events.publish(Work.Event.EvidenceRecorded, {
          goalID: goal.id,
          timestamp,
          info: Work.EvidenceInfo.make({
            id: evidenceID,
            goalID: goal.id,
            taskID: task.id,
            attemptID: attempt.id,
            criterionIDs: criteria.map((criterion) => criterion.id),
            kind: "review",
            producer: "work-reviewer/1",
            payload: output,
            digest: hash(JSON.stringify(output)),
            createdAt: timestamp,
          }),
        })
      for (const result of output.criteria) {
        const evaluationID = WorkReviewer.evaluationID(attempt.id, result.criterionID)
        if ((yield* store.evaluations(task.id)).some((evaluation) => evaluation.id === evaluationID)) continue
        yield* events.publish(Work.Event.EvaluationRecorded, {
          goalID: goal.id,
          timestamp,
          info: Work.EvaluationInfo.make({
            id: evaluationID,
            goalID: goal.id,
            taskID: task.id,
            attemptID: attempt.id,
            criterionID: result.criterionID,
            evidenceIDs: [evidenceID],
            verdict: result.verdict,
            evaluator: "work-reviewer",
            evaluatorVersion: "1",
            findings: result.findings,
            allowsRepair: result.allowsRepair,
            createdAt: timestamp,
          }),
        })
      }
      yield* events.publish(Work.Event.AttemptSettled, {
        goalID: goal.id,
        attemptID: attempt.id,
        status: "succeeded",
        ownerID,
        fence,
        timestamp,
      })
      const settled = yield* store.getAttempt(attempt.id)
      if (!settled) return yield* Effect.die(`Review Attempt not projected: ${attempt.id}`)
      return yield* settleReview(goal, task, settled, criteria, claim)
    })

    const review = Effect.fn("WorkRunner.review")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      claim: WorkLease.Claim,
    ) {
      const criteria = goal.acceptanceCriteria.filter(
        (criterion) => criterion.required && task.criteria.includes(criterion.id),
      )
      if (criteria.length === 0) {
        return yield* completeTask(goal, task, claim)
      }

      const attempts = yield* store.attempts(task.id)
      const latest = attempts.at(-1)
      if (latest?.kind === "review" && latest.status === "running") return false
      if (latest?.kind === "review" && latest.status === "admitted")
        return yield* executeReview(goal, task, latest, criteria, claim)
      if (latest?.kind === "review" && latest.status === "succeeded")
        return yield* settleReview(goal, task, latest, criteria, claim)
      if (task.attemptCount >= maxAttempts(goal)) {
        yield* exhaustBudget(goal, task, "Review Attempt budget exhausted")
        return false
      }

      const attemptID = Work.AttemptID.create()
      const sessionID = SessionV2.ID.make(`ses_${attemptID.slice("attempt_".length)}`)
      yield* sessions.create({
        id: sessionID,
        location: task.location ?? goal.location,
        agent: AgentV2.ID.make("review"),
      })
      const timestamp = yield* DateTime.now
      yield* events.publish(Work.Event.AttemptAdmitted, {
        goalID: goal.id,
        timestamp,
        info: Work.AttemptInfo.make({
          id: attemptID,
          goalID: goal.id,
          taskID: task.id,
          kind: "review",
          number: task.attemptCount + 1,
          sessionID,
          status: "admitted",
          inputRevision: task.revision,
          time: { created: timestamp },
        }),
      })
      const attempt = yield* store.getAttempt(attemptID)
      if (!attempt) return yield* Effect.die(`Review Attempt not projected: ${attemptID}`)
      return yield* executeReview(goal, task, attempt, criteria, claim)
    })

    const provisionGraph = Effect.fn("WorkRunner.provisionGraph")(function* (
      goal: Work.GoalInfo,
      tasks: ReadonlyArray<WorkPlanner.ValidatedTask>,
    ) {
      if (!tasks.some((task) => task.isolation === "worktree")) return tasks
      const repository = yield* git.repo.discover(goal.location.directory)
      if (!repository) {
        yield* Effect.logWarning("WorkGraph isolation unavailable; using shared workspace", {
          goalID: goal.id,
          reason: "not_git",
        })
        return tasks
      }
      const baseline = yield* git.change.capture({ repository, path: goal.location.directory })
      if (baseline.length > 0) {
        yield* Effect.logWarning("WorkGraph isolation deferred for dirty workspace; using shared workspace", {
          goalID: goal.id,
        })
        return tasks
      }
      return yield* Effect.forEach(tasks, (task) => {
        if (task.isolation !== "worktree") return Effect.succeed(task)
        return Effect.gen(function* () {
          const location = yield* Location.Service
          const copies = yield* ProjectCopy.Service
          const root = AbsolutePath.make(path.join(Global.Path.data, "worktree", location.project.id))
          const name = `work-${goal.id.slice("goal_".length, "goal_".length + 8)}-${task.id.slice("task_".length, "task_".length + 8)}`
          const expected = AbsolutePath.make(path.join(root, name))
          yield* copies.refresh({ projectID: location.project.id })
          const existing = (yield* projectDirectories.list(location.project.id)).find(
            (item) => item.directory === expected && item.strategy === "git_worktree",
          )
          if (existing) return { ...task, location: { directory: existing.directory } }
          const created = yield* copies.create({
            projectID: location.project.id,
            strategy: ProjectCopy.StrategyID.make("git_worktree"),
            sourceDirectory: goal.location.directory,
            directory: root,
            name,
          })
          return { ...task, location: { directory: created.directory } }
        }).pipe(
          Effect.provide(locations.get(goal.location)),
          Effect.catchCause((cause) =>
            Effect.logWarning("WorkGraph Task isolation failed; using shared workspace", cause).pipe(
              Effect.annotateLogs({ goalID: goal.id, taskID: task.id }),
              Effect.as(task),
            ),
          ),
        )
      })
    })

    const preparePlan = Effect.fn("WorkRunner.preparePlan")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      attempt: Work.AttemptInfo,
    ) {
      const input = { goal, task, attempt }
      const text = yield* dispatchRemoteAgent(goal, task, attempt, WorkPlanner.prompt(input)).pipe(
        Effect.flatMap(remoteAgentText),
      )
      const output = yield* text === undefined ? planner.run(input) : WorkPlanner.parse(text)
      const validated = yield* WorkPlanner.validate(goal, output)
      const planned = yield* provisionGraph(goal, validated)
      const timestamp = yield* DateTime.now
      return planned.map((item) =>
        Work.TaskInfo.make({
          id: item.id,
          goalID: goal.id,
          title: item.title,
          instructions: item.instructions,
          dependsOn: item.dependsOn,
          role: item.role,
          location: item.location,
          status: "pending",
          criteria: item.criteria,
          attemptCount: 0,
          time: { created: timestamp, updated: timestamp },
          revision: 0,
        }),
      )
    })

    const persistPlan = Effect.fn("WorkRunner.persistPlan")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      tasks: ReadonlyArray<Work.TaskInfo>,
    ) {
      yield* events.publish(Work.Event.TaskGraphPlanned, {
        goalID: goal.id,
        plannerTaskID: task.id,
        timestamp: yield* DateTime.now,
        tasks,
      })
      yield* events.publish(Work.Event.TaskVerificationStarted, {
        goalID: goal.id,
        taskID: task.id,
        status: "verifying",
        timestamp: yield* DateTime.now,
      })
      yield* events.publish(Work.Event.TaskCompleted, {
        goalID: goal.id,
        taskID: task.id,
        status: "completed",
        timestamp: yield* DateTime.now,
      })
    })

    const blockPlan = Effect.fn("WorkRunner.blockPlan")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      reason: string,
    ) {
      const timestamp = yield* DateTime.now
      yield* events.publish(Work.Event.TaskBlocked, {
        goalID: goal.id,
        taskID: task.id,
        status: "blocked",
        reason,
        timestamp,
      })
      yield* blockGoal(goal.id, reason, timestamp)
      return false
    })

    const executePlan = Effect.fn("WorkRunner.executePlan")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      attempt: Work.AttemptInfo,
      claim: WorkLease.Claim,
    ) {
      yield* leases.assert(claim)
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID: goal.id,
        attemptID: attempt.id,
        ownerID: claim.ownerID,
        fence: claim.fence,
        timestamp: yield* DateTime.now,
      })
      const result = yield* Effect.uninterruptibleMask((restore) =>
        restore(preparePlan(goal, task, attempt)).pipe(Effect.exit),
      )
      const timestamp = yield* DateTime.now
      yield* leases.assert(claim)
      if (Exit.isSuccess(result)) {
        yield* events.publish(Work.Event.AttemptSettled, {
          goalID: goal.id,
          attemptID: attempt.id,
          status: "succeeded",
          ownerID: claim.ownerID,
          fence: claim.fence,
          timestamp,
        })
        yield* persistPlan(goal, task, result.value)
        return true
      }
      const interrupted = Cause.hasInterrupts(result.cause)
      yield* events.publish(Work.Event.AttemptSettled, {
        goalID: goal.id,
        attemptID: attempt.id,
        status: interrupted ? "interrupted" : "failed",
        ownerID: claim.ownerID,
        fence: claim.fence,
        failure: {
          kind: interrupted ? "interrupted" : "error",
          message: interrupted ? "Planning interrupted" : errorText(Cause.squash(result.cause)),
          retryable: !interrupted,
        },
        timestamp,
      })
      if (interrupted) return false
      if (retryAvailable(goal, task)) return true
      yield* exhaustBudget(goal, task, "Retryable Planner failure exhausted the Attempt budget")
      return false
    })

    const plan = Effect.fn("WorkRunner.plan")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      claim: WorkLease.Claim,
    ) {
      if ((yield* store.tasks(goal.id)).some((candidate) => candidate.id !== task.id)) {
        yield* events.publish(Work.Event.TaskVerificationStarted, {
          goalID: goal.id,
          taskID: task.id,
          status: "verifying",
          timestamp: yield* DateTime.now,
        })
        yield* events.publish(Work.Event.TaskCompleted, {
          goalID: goal.id,
          taskID: task.id,
          status: "completed",
          timestamp: yield* DateTime.now,
        })
        return true
      }
      const latest = (yield* store.attempts(task.id)).at(-1)
      if (latest?.status === "running") return false
      if (latest?.status === "admitted") return yield* executePlan(goal, task, latest, claim)
      if (latest?.kind === "plan" && latest.status === "succeeded") {
        const prepared = yield* preparePlan(goal, task, latest).pipe(Effect.exit)
        if (Exit.isSuccess(prepared)) {
          yield* persistPlan(goal, task, prepared.value)
          return true
        }
        return yield* blockPlan(goal, task, `Planner recovery failed: ${errorText(Cause.squash(prepared.cause))}`)
      }
      if (task.attemptCount >= maxAttempts(goal)) {
        yield* exhaustBudget(goal, task, "Planner Attempt budget exhausted")
        return false
      }
      const attemptID = Work.AttemptID.create()
      const sessionID = SessionV2.ID.make(`ses_${attemptID.slice("attempt_".length)}`)
      yield* sessions.create({ id: sessionID, location: goal.location, agent: AgentV2.ID.make("work-planner") })
      const timestamp = yield* DateTime.now
      yield* events.publish(Work.Event.AttemptAdmitted, {
        goalID: goal.id,
        timestamp,
        info: Work.AttemptInfo.make({
          id: attemptID,
          goalID: goal.id,
          taskID: task.id,
          kind: "plan",
          number: task.attemptCount + 1,
          sessionID,
          status: "admitted",
          inputRevision: task.revision,
          time: { created: timestamp },
        }),
      })
      const attempt = yield* store.getAttempt(attemptID)
      if (!attempt) return yield* Effect.die(`Planner Attempt not projected: ${attemptID}`)
      return yield* executePlan(goal, task, attempt, claim)
    })

    const replanPersisted = Effect.fn("WorkRunner.replanPersisted")(function* (
      goalID: Work.GoalID,
      architectTaskID: Work.TaskID,
    ) {
      let cursor = -1
      while (true) {
        const history = yield* EventV2.readAggregate(db, {
          aggregateID: goalID,
          after: cursor,
          limit: 500,
          manifest: DurableEventManifest.WorkDurable,
        })
        if (
          history.events.some(
            (event) =>
              event.type === Work.Event.TaskGraphReplanned.type && event.data.architectTaskID === architectTaskID,
          )
        )
          return true
        if (!history.hasMore) return false
        const next = history.events.at(-1)?.durable?.seq
        if (next === undefined) return false
        cursor = next
      }
    })

    const prepareReplan = Effect.fn("WorkRunner.prepareReplan")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      attempt: Work.AttemptInfo,
    ) {
      const tasks = yield* store.tasks(goal.id)
      const evaluations = (yield* Effect.forEach(tasks, (candidate) => store.evaluations(candidate.id))).flat()
      const handoffs = yield* store.handoffs(goal.id)
      const input = { goal, task, attempt, tasks, evaluations, handoffs }
      const text = yield* dispatchRemoteAgent(goal, task, attempt, WorkArchitect.prompt(input)).pipe(
        Effect.flatMap(remoteAgentText),
      )
      const output = yield* text === undefined ? architect.run(input) : WorkArchitect.parse(text)
      const validated = yield* WorkArchitect.validate(goal, task, tasks, output)
      const planned = yield* provisionGraph(goal, validated.tasks)
      const timestamp = yield* DateTime.now
      return {
        supersededTaskIDs: validated.supersededTaskIDs,
        tasks: planned.map((item) =>
          Work.TaskInfo.make({
            id: item.id,
            goalID: goal.id,
            title: item.title,
            instructions: item.instructions,
            dependsOn: item.dependsOn,
            role: item.role,
            location: item.location,
            status: "pending",
            criteria: item.criteria,
            attemptCount: 0,
            time: { created: timestamp, updated: timestamp },
            revision: 0,
          }),
        ),
      }
    })

    const persistReplan = Effect.fn("WorkRunner.persistReplan")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      prepared: {
        readonly supersededTaskIDs: ReadonlyArray<Work.TaskID>
        readonly tasks: ReadonlyArray<Work.TaskInfo>
      },
    ) {
      yield* Effect.forEach(
        prepared.supersededTaskIDs,
        (taskID) =>
          Effect.gen(function* () {
            const superseded = yield* store.getTask(taskID)
            if (!superseded) return
            const artifact = yield* isolation.archive(goal, superseded)
            if (!artifact) return
            yield* events.publish(Work.Event.TaskIsolationArchived, {
              goalID: goal.id,
              taskID,
              artifact,
              reason: "superseded",
              timestamp: yield* DateTime.now,
            })
            yield* isolation.release(goal, superseded)
          }),
        { concurrency: 1, discard: true },
      )
      yield* events.publish(Work.Event.TaskGraphReplanned, {
        goalID: goal.id,
        architectTaskID: task.id,
        supersededTaskIDs: prepared.supersededTaskIDs,
        tasks: prepared.tasks,
        timestamp: yield* DateTime.now,
      })
      yield* events.publish(Work.Event.TaskVerificationStarted, {
        goalID: goal.id,
        taskID: task.id,
        status: "verifying",
        timestamp: yield* DateTime.now,
      })
      yield* events.publish(Work.Event.TaskCompleted, {
        goalID: goal.id,
        taskID: task.id,
        status: "completed",
        timestamp: yield* DateTime.now,
      })
    })

    const blockReplan = Effect.fn("WorkRunner.blockReplan")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      reason: string,
    ) {
      const timestamp = yield* DateTime.now
      yield* events.publish(Work.Event.TaskBlocked, {
        goalID: goal.id,
        taskID: task.id,
        status: "blocked",
        reason,
        timestamp,
      })
      yield* blockGoal(goal.id, reason, timestamp)
      return false
    })

    const executeReplan = Effect.fn("WorkRunner.executeReplan")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      attempt: Work.AttemptInfo,
      claim: WorkLease.Claim,
    ) {
      yield* leases.assert(claim)
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID: goal.id,
        attemptID: attempt.id,
        ownerID: claim.ownerID,
        fence: claim.fence,
        timestamp: yield* DateTime.now,
      })
      const result = yield* Effect.uninterruptibleMask((restore) =>
        restore(prepareReplan(goal, task, attempt)).pipe(Effect.exit),
      )
      const timestamp = yield* DateTime.now
      yield* leases.assert(claim)
      if (Exit.isSuccess(result)) {
        yield* events.publish(Work.Event.AttemptSettled, {
          goalID: goal.id,
          attemptID: attempt.id,
          status: "succeeded",
          ownerID: claim.ownerID,
          fence: claim.fence,
          timestamp,
        })
        yield* persistReplan(goal, task, result.value)
        return true
      }
      const interrupted = Cause.hasInterrupts(result.cause)
      yield* events.publish(Work.Event.AttemptSettled, {
        goalID: goal.id,
        attemptID: attempt.id,
        status: interrupted ? "interrupted" : "failed",
        ownerID: claim.ownerID,
        fence: claim.fence,
        failure: {
          kind: interrupted ? "interrupted" : "error",
          message: interrupted ? "Replanning interrupted" : errorText(Cause.squash(result.cause)),
          retryable: !interrupted,
        },
        timestamp,
      })
      if (interrupted) return false
      if (retryAvailable(goal, task)) return true
      yield* exhaustBudget(goal, task, "Retryable Architect failure exhausted the Attempt budget")
      return false
    })

    const replan = Effect.fn("WorkRunner.replan")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      claim: WorkLease.Claim,
    ) {
      if (yield* replanPersisted(goal.id, task.id)) {
        yield* events.publish(Work.Event.TaskVerificationStarted, {
          goalID: goal.id,
          taskID: task.id,
          status: "verifying",
          timestamp: yield* DateTime.now,
        })
        yield* events.publish(Work.Event.TaskCompleted, {
          goalID: goal.id,
          taskID: task.id,
          status: "completed",
          timestamp: yield* DateTime.now,
        })
        return true
      }
      const latest = (yield* store.attempts(task.id)).at(-1)
      if (latest?.status === "running") return false
      if (latest?.status === "admitted") return yield* executeReplan(goal, task, latest, claim)
      if (latest?.kind === "replan" && latest.status === "succeeded") {
        const prepared = yield* prepareReplan(goal, task, latest).pipe(Effect.exit)
        if (Exit.isSuccess(prepared)) {
          yield* persistReplan(goal, task, prepared.value)
          return true
        }
        return yield* blockReplan(goal, task, `Architect recovery failed: ${errorText(Cause.squash(prepared.cause))}`)
      }
      if (task.attemptCount >= maxAttempts(goal)) {
        yield* exhaustBudget(goal, task, "Architect Attempt budget exhausted")
        return false
      }
      const attemptID = Work.AttemptID.create()
      const sessionID = SessionV2.ID.make(`ses_${attemptID.slice("attempt_".length)}`)
      yield* sessions.create({ id: sessionID, location: goal.location, agent: AgentV2.ID.make("work-architect") })
      const timestamp = yield* DateTime.now
      yield* events.publish(Work.Event.AttemptAdmitted, {
        goalID: goal.id,
        timestamp,
        info: Work.AttemptInfo.make({
          id: attemptID,
          goalID: goal.id,
          taskID: task.id,
          kind: "replan",
          number: task.attemptCount + 1,
          sessionID,
          status: "admitted",
          inputRevision: task.revision,
          time: { created: timestamp },
        }),
      })
      const attempt = yield* store.getAttempt(attemptID)
      if (!attempt) return yield* Effect.die(`Architect Attempt not projected: ${attemptID}`)
      return yield* executeReplan(goal, task, attempt, claim)
    })

    const advance = Effect.fn("WorkRunner.advance")(function* (
      goal: Work.GoalInfo,
      candidate: Work.TaskInfo,
      claim: WorkLease.Claim,
    ) {
      if (candidate.status === "merging") return yield* merge(goal, candidate, claim)
      if (candidate.status === "verifying") {
        const attempt = (yield* store.attempts(candidate.id)).at(-1)
        if (!attempt || attempt.status !== "succeeded") return false
        return yield* verify(goal, candidate, attempt, claim)
      }
      if (candidate.status === "reviewing") return yield* review(goal, candidate, claim)

      const startingRepair = candidate.status === "rework"
      if (candidate.status === "ready" || candidate.status === "rework")
        yield* events.publish(Work.Event.TaskStarted, {
          goalID: goal.id,
          taskID: candidate.id,
          status: "running",
          timestamp: yield* DateTime.now,
        })
      const task = yield* store.getTask(candidate.id)
      if (!task || task.status !== "running") return false
      if (task.role === "work-planner") return yield* plan(goal, task, claim)
      if (task.role === "work-architect") return yield* replan(goal, task, claim)

      const latest = (yield* store.attempts(task.id)).at(-1)
      if (latest?.status === "running") return false
      if (latest?.status === "admitted") {
        yield* execute(goal, task, latest, claim)
        return true
      }
      if (latest?.status === "succeeded" && !startingRepair) {
        yield* events.publish(Work.Event.TaskVerificationStarted, {
          goalID: goal.id,
          taskID: task.id,
          status: "verifying",
          timestamp: yield* DateTime.now,
        })
        return true
      }
      if (task.attemptCount >= maxAttempts(goal)) {
        yield* exhaustBudget(goal, task, "Attempt budget exhausted")
        return false
      }
      if (task.attemptCount > 0 && goal.usage.repairs >= (goal.budget?.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS)) {
        yield* exhaustBudget(goal, task, "Repair budget exhausted")
        return false
      }

      const attemptID = Work.AttemptID.create()
      const sessionID = SessionV2.ID.make(`ses_${attemptID.slice("attempt_".length)}`)
      const agentID = WorkRole.agentID(task.role, goal.roleContracts ?? WorkRole.contracts)
      if (!agentID) {
        const timestamp = yield* DateTime.now
        yield* events.publish(Work.Event.TaskBlocked, {
          goalID: goal.id,
          taskID: task.id,
          status: "blocked",
          reason: `Role Contract is unavailable: ${task.role}`,
          timestamp,
        })
        yield* blockGoal(goal.id, `Role Contract is unavailable: ${task.role}`, timestamp)
        return false
      }
      yield* sessions.create({
        id: sessionID,
        location: task.location ?? goal.location,
        agent: agentID,
      })
      const timestamp = yield* DateTime.now
      yield* events.publish(Work.Event.AttemptAdmitted, {
        goalID: goal.id,
        timestamp,
        info: Work.AttemptInfo.make({
          id: attemptID,
          goalID: goal.id,
          taskID: task.id,
          kind: startingRepair ? "repair" : "execute",
          number: task.attemptCount + 1,
          sessionID,
          status: "admitted",
          inputRevision: task.revision,
          time: { created: timestamp },
        }),
      })
      const attempt = yield* store.getAttempt(attemptID)
      if (!attempt) return yield* Effect.die(`Attempt not projected: ${attemptID}`)
      yield* execute(goal, task, attempt, claim)
      return true
    })

    const step = Effect.fn("WorkRunner.step")(function* (goalID: Work.GoalID, claim: WorkLease.Claim) {
      yield* leases.assert(claim)
      const goal = yield* store.getGoal(goalID)
      if (!goal || goal.status !== "active") return false
      const tasks = yield* store.tasks(goal.id)
      yield* Effect.forEach(
        tasks.filter((task) => task.status === "completed" || task.status === "superseded"),
        (task) => isolation.release(goal, task),
        { concurrency: 4, discard: true },
      )
      yield* Effect.forEach(
        tasks.filter((task) => task.status === "completed"),
        (task) =>
          ensureHandoff(goal, task).pipe(
            Effect.catch((error) =>
              blockGoal(
                goal.id,
                `Failed to create a durable Handoff for ${task.id}: ${errorText(error)}`,
                DateTime.nowUnsafe(),
              ),
            ),
          ),
        { concurrency: 1, discard: true },
      )
      if ((yield* store.getGoal(goal.id))?.status !== "active") return false
      yield* ensureRoutes(goal, tasks)
      if (tasks.length === 0) {
        yield* blockGoal(goal.id, "Goal has no Tasks", yield* DateTime.now)
        return false
      }
      const handoffs = yield* store.handoffs(goal.id)
      const handedOff = new Set(handoffs.map((handoff) => handoff.taskID))
      if (tasks.every((task) => task.status === "completed" || task.status === "superseded")) {
        const missing = tasks.find(
          (task) =>
            task.status === "completed" &&
            task.role !== "work-planner" &&
            task.role !== "work-architect" &&
            !handedOff.has(task.id),
        )
        if (missing) {
          yield* blockGoal(goal.id, `Completed Task has no recoverable Handoff: ${missing.id}`, yield* DateTime.now)
          return false
        }
        yield* finishGoal(goal, yield* DateTime.now)
        return false
      }

      const budgetReason = exhaustedBudgetReason(goal, DateTime.toEpochMillis(yield* DateTime.now))
      if (budgetReason) {
        const task = tasks.find((candidate) => !WorkStateMachine.isTaskTerminal(candidate.status))
        if (task) yield* exhaustBudget(goal, task, budgetReason)
        return false
      }

      const completed = new Set(
        tasks.filter((task) => task.status === "completed" || task.status === "superseded").map((task) => task.id),
      )
      const withoutHandoff = new Set(
        tasks
          .filter(
            (task) => task.status === "superseded" || task.role === "work-planner" || task.role === "work-architect",
          )
          .map((task) => task.id),
      )
      yield* Effect.forEach(
        tasks.filter((task) => {
          if (task.status !== "pending") return false
          const routed = new Set(
            handoffs.filter((handoff) => handoff.recipients.includes(task.id)).map((handoff) => handoff.taskID),
          )
          return task.dependsOn.every(
            (dependencyID) =>
              completed.has(dependencyID) && (routed.has(dependencyID) || withoutHandoff.has(dependencyID)),
          )
        }),
        (task) =>
          events.publish(Work.Event.TaskReadied, {
            goalID: goal.id,
            taskID: task.id,
            status: "ready",
            timestamp: DateTime.nowUnsafe(),
          }),
        { concurrency: 1, discard: true },
      )

      const candidates = (yield* store.tasks(goal.id)).filter((task) =>
        ["ready", "running", "verifying", "reviewing", "merging", "rework"].includes(task.status),
      )
      if (candidates.length === 0) return false
      const merging = candidates.find((task) => task.status === "merging")
      const maximum = goal.budget?.maxParallelTasks ?? 3
      const selected = merging
        ? [merging]
        : [
            ...candidates
              .filter((task) => !task.location || task.location.directory === goal.location.directory)
              .slice(0, 1),
            ...candidates.filter(
              (task) => task.location !== undefined && task.location.directory !== goal.location.directory,
            ),
          ].slice(0, maximum)
      const progressed = yield* Effect.forEach(selected, (task) => advance(goal, task, claim), {
        concurrency: maximum,
      })
      return progressed.some(Boolean)
    })

    const exhaustBudget = Effect.fn("WorkRunner.exhaustBudget")(function* (
      goal: Work.GoalInfo,
      task: Work.TaskInfo,
      reason: string,
    ) {
      const timestamp = yield* DateTime.now
      yield* events.publish(Work.Event.TaskBlocked, {
        goalID: goal.id,
        taskID: task.id,
        status: "blocked",
        reason,
        timestamp,
      })
      yield* goalTransitions.withLock(goal.id)(
        Effect.gen(function* () {
          if ((yield* store.getGoal(goal.id))?.status !== "active") return
          yield* events.publish(Work.Event.GoalBudgetExhausted, { goalID: goal.id, reason, timestamp })
        }),
      )
    })

    const resumableBlockedTasks = Effect.fn("WorkRunner.resumableBlockedTasks")(function* (goalID: Work.GoalID) {
      const blocked = (yield* store.tasks(goalID)).filter((task) => task.status === "blocked")
      if (blocked.length === 0) return []

      const reasons = new Map<Work.TaskID, string>()
      let cursor = -1
      while (true) {
        const history = yield* EventV2.readAggregate(db, {
          aggregateID: goalID,
          after: cursor,
          limit: 500,
          manifest: DurableEventManifest.WorkDurable,
        })
        history.events
          .filter((event) => event.type === Work.Event.TaskBlocked.type)
          .forEach((event) => reasons.set(event.data.taskID, event.data.reason))
        if (!history.hasMore) break
        const next = history.events.at(-1)?.durable?.seq
        if (next === undefined) break
        cursor = next
      }

      const candidates = yield* Effect.forEach(blocked, (task) =>
        store
          .attempts(task.id)
          .pipe(
            Effect.map((attempts) =>
              [
                reasons.get(task.id),
                attempts.findLast((attempt) => attempt.failure !== undefined)?.failure?.message,
              ].some((reason) => reason !== undefined && WorkAccessFailure.recoverable(reason))
                ? task
                : undefined,
            ),
          ),
      )
      return candidates.filter((task): task is Work.TaskInfo => task !== undefined)
    })

    return Service.of({
      run: Effect.fn("WorkRunner.run")((input) =>
        leases
          .run(input.goalID, (claim) =>
            Effect.gen(function* () {
              const initial = yield* store
                .getGoal(input.goalID)
                .pipe(
                  Effect.flatMap((goal) =>
                    goal ? Effect.succeed(goal) : Effect.die(`Goal not found: ${input.goalID}`),
                  ),
                )
              const resumable =
                input.force && initial.status === "blocked" ? yield* resumableBlockedTasks(input.goalID) : []
              if (input.force && (initial.status === "draft" || initial.status === "paused" || resumable.length > 0)) {
                yield* events.publish(Work.Event.GoalActivated, {
                  goalID: input.goalID,
                  timestamp: yield* DateTime.now,
                })
              }
              if (resumable.length > 0) {
                const timestamp = yield* DateTime.now
                yield* Effect.forEach(
                  resumable,
                  (task) =>
                    events.publish(Work.Event.TaskReworkRequested, {
                      goalID: input.goalID,
                      taskID: task.id,
                      status: "rework",
                      reason: "Access repaired after user intervention",
                      timestamp,
                    }),
                  { concurrency: 1, discard: true },
                )
              }

              while (yield* step(input.goalID, claim)) {}
            }),
          )
          .pipe(
            Effect.catchTag("WorkLease.Lost", (error) =>
              Effect.logWarning("Work lease lost; stopping stale Goal owner", {
                goalID: error.goalID,
                ownerID: error.ownerID,
                fence: error.fence,
              }),
            ),
            Effect.asVoid,
          ),
      ),
    })
  }),
)

function promptID(attemptID: Work.AttemptID) {
  return SessionMessage.ID.make(`msg_${attemptID.slice("attempt_".length)}`)
}

function maxAttempts(goal: Work.GoalInfo) {
  return goal.budget?.maxAttemptsPerTask ?? DEFAULT_MAX_ATTEMPTS_PER_TASK
}

function retryAvailable(goal: Work.GoalInfo, task: Work.TaskInfo) {
  return task.attemptCount < maxAttempts(goal)
}

function repairAvailable(goal: Work.GoalInfo, task: Work.TaskInfo) {
  return (
    task.attemptCount < maxAttempts(goal) &&
    goal.usage.repairs < (goal.budget?.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS)
  )
}

function exhaustedBudgetReason(goal: Work.GoalInfo, now: number) {
  if (
    goal.budget?.maxDurationMs !== undefined &&
    now - DateTime.toEpochMillis(goal.time.created) >= goal.budget.maxDurationMs
  )
    return "Goal duration budget exhausted"
  if (goal.budget?.maxTurns !== undefined && goal.usage.turns >= goal.budget.maxTurns)
    return "Goal provider-turn budget exhausted"
  if (goal.budget?.maxCost !== undefined && goal.usage.cost >= goal.budget.maxCost)
    return "Goal cost budget exhausted"
  return undefined
}

function instructions(
  goal: Work.GoalInfo,
  task: Work.TaskInfo,
  evaluations: ReadonlyArray<Work.EvaluationInfo>,
  dependencies: string,
) {
  const contract = WorkRole.get(task.role, goal.roleContracts ?? WorkRole.contracts)
  const criteria = goal.acceptanceCriteria
    .filter((criterion) => task.criteria.includes(criterion.id))
    .map((criterion) => `- [${criterion.id}] ${criterion.description}`)
    .join("\n")
  return [
    `Goal: ${goal.objective}`,
    `Task: ${task.title}`,
    `Role: ${task.role}`,
    contract ? `Role Contract: ${JSON.stringify(contract)}` : "",
    task.instructions,
    dependencies ? `Results from completed dependencies:\n${dependencies}` : "",
    criteria ? `Acceptance criteria:\n${criteria}` : "",
    repairFindings(evaluations),
    contract?.workspaceAccess === "read_only"
      ? "Inspect the current workspace without modifying it. Report concrete findings for downstream Tasks."
      : "Complete the implementation in the current workspace. Report what changed and what verification you ran.",
    'End the final response with a machine-readable Handoff block in this exact form: <work-handoff>{"summary":"concise verified outcome","items":[{"kind":"result|fact|decision|constraint|risk|artifact|lesson|next_action","text":"...","reference":"optional file, command, or artifact reference","memory":"task|project","key":"required stable key for project memory","expiresAt":1700000000000}]}</work-handoff>. Use valid JSON and only kinds permitted by the Role Contract. Default to task memory. Use project memory only for reusable project facts, decisions, constraints, or lessons; it requires a stable key and expiresAt is an optional epoch-millisecond expiry. Include only claims supported by the work and verification, and never include secrets.',
  ]
    .filter((part) => part.length > 0)
    .join("\n\n")
}

function repairFindings(evaluations: ReadonlyArray<Work.EvaluationInfo>) {
  const findings = evaluations
    .filter((evaluation) => evaluation.verdict !== "pass")
    .flatMap((evaluation) => evaluation.findings.map((finding) => `- [${evaluation.criterionID}] ${finding.message}`))
    .slice(-20)
  return findings.length > 0 ? `Findings from the previous verification:\n${findings.join("\n")}` : ""
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function failureSignature(evaluation: Work.EvaluationInfo) {
  return hash(
    JSON.stringify({
      criterionID: evaluation.criterionID,
      findings: evaluation.findings.map((finding) => ({
        code: finding.code,
        message: finding.message,
        severity: finding.severity,
        location: finding.location,
      })),
    }),
  )
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    EventV2.node,
    Git.node,
    LocationServiceMap.node,
    ProjectDirectories.node,
    SessionV2.node,
    WorkStore.node,
    WorkArtifact.node,
    WorkRemoteJob.node,
    WorkArchitect.node,
    WorkIsolation.node,
    WorkVerifier.node,
    WorkReviewer.node,
    WorkPlanner.node,
    WorkLease.node,
  ],
})
