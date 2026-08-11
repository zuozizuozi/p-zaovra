export * as WorkArchitect from "./architect"

import { Location } from "@zaovra-ai/schema/location"
import { Work } from "@zaovra-ai/schema/work"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionV2 } from "../session"
import { SessionMessage } from "../session/message"
import { SessionRunner } from "../session/runner"
import { WorkRole } from "./role"

export type Input = {
  readonly goal: Work.GoalInfo
  readonly task: Work.TaskInfo
  readonly attempt: Work.AttemptInfo
  readonly tasks: ReadonlyArray<Work.TaskInfo>
  readonly evaluations: ReadonlyArray<Work.EvaluationInfo>
  readonly handoffs: ReadonlyArray<Work.HandoffInfo>
}

export type ValidatedTask = {
  readonly id: Work.TaskID
  readonly title: string
  readonly instructions: string
  readonly dependsOn: ReadonlyArray<Work.TaskID>
  readonly role: Work.PlanRole
  readonly isolation: Work.PlanIsolation
  readonly criteria: ReadonlyArray<Work.CriterionID>
  readonly location?: Location.Ref
}

export type ValidatedReplan = {
  readonly supersededTaskIDs: ReadonlyArray<Work.TaskID>
  readonly tasks: ReadonlyArray<ValidatedTask>
}

export class InvalidOutputError extends Schema.TaggedErrorClass<InvalidOutputError>()("WorkArchitect.InvalidOutput", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly run: (
    input: Input,
  ) => Effect.Effect<Work.ReplanOutput, InvalidOutputError | SessionV2.Error | SessionRunner.RunError>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkArchitect") {}

const ReplanJson = Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Work.ReplanOutput))
const decode = Schema.decodeUnknownEffect(ReplanJson)

export const parse = Effect.fn("WorkArchitect.parse")(function* (text: string) {
  const normalized = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
  return yield* decode(normalized).pipe(
    Effect.mapError(() => new InvalidOutputError({ message: "Architect did not return valid structured JSON" })),
  )
})

export const validate = Effect.fn("WorkArchitect.validate")(function* (
  goal: Work.GoalInfo,
  architectTask: Work.TaskInfo,
  existing: ReadonlyArray<Work.TaskInfo>,
  output: Work.ReplanOutput,
) {
  const roleContracts = goal.roleContracts ?? WorkRole.contracts
  if (output.tasks.length === 0) return yield* invalid("Architect returned an empty Task graph")
  if (output.tasks.length > 24) return yield* invalid("Architect returned more than 24 Tasks")
  const keys = output.tasks.map((task) => task.key)
  if (new Set(keys).size !== keys.length) return yield* invalid("Architect Task keys must be unique")
  const byExistingID = new Map<string, Work.TaskInfo>(existing.map((task) => [task.id, task]))
  if (new Set(output.supersedes).size !== output.supersedes.length)
    return yield* invalid("Superseded Task IDs must be unique")
  const invalidSuperseded = output.supersedes.find((taskID) => {
    const task = byExistingID.get(taskID)
    return task?.status !== "blocked"
  })
  if (invalidSuperseded) return yield* invalid(`Task ${invalidSuperseded} is not blocked`)
  const superseded = new Set(output.supersedes)
  const blocked = existing.filter((task) => task.status === "blocked")
  if (blocked.length !== superseded.size || blocked.some((task) => !superseded.has(task.id)))
    return yield* invalid("Architect must supersede every blocked Task")
  const knownKeys = new Set(keys)
  const invalidDependency = output.tasks.find(
    (task) =>
      new Set(task.dependsOn).size !== task.dependsOn.length ||
      task.dependsOn.includes(task.key) ||
      task.dependsOn.some((dependency) => {
        if (knownKeys.has(dependency)) return false
        const existingTask = byExistingID.get(dependency)
        return (
          !existingTask ||
          (existingTask.status !== "completed" &&
            existingTask.status !== "superseded" &&
            !superseded.has(existingTask.id))
        )
      }),
  )
  if (invalidDependency) return yield* invalid(`Architect Task ${invalidDependency.key} has invalid dependencies`)
  const knownCriteria = new Set(goal.acceptanceCriteria.map((criterion) => criterion.id))
  const invalidCriterion = output.tasks.find(
    (task) =>
      new Set(task.criteria).size !== task.criteria.length ||
      task.criteria.some((criterionID) => !knownCriteria.has(criterionID)),
  )
  if (invalidCriterion) return yield* invalid(`Architect Task ${invalidCriterion.key} has invalid criteria`)
  const invalidRole = output.tasks.find((task) => !WorkRole.get(task.role, roleContracts))
  if (invalidRole)
    return yield* invalid(`Architect Task ${invalidRole.key} uses unknown Role Contract ${invalidRole.role}`)
  const invalidIsolation = output.tasks.find(
    (task) => !WorkRole.allowsIsolation(task.role, task.isolation, roleContracts),
  )
  if (invalidIsolation)
    return yield* invalid(
      `Role ${invalidIsolation.role} does not permit ${invalidIsolation.isolation} isolation for Task ${invalidIsolation.key}`,
    )
  const reassigned = new Set(output.tasks.flatMap((task) => task.criteria))
  const uncovered = output.supersedes
    .flatMap((taskID) => byExistingID.get(taskID)?.criteria ?? [])
    .find((criterionID) => !reassigned.has(criterionID))
  if (uncovered) return yield* invalid(`Superseded criterion ${uncovered} is not assigned to a replacement Task`)
  const effectiveCriteria = new Set([
    ...existing.filter((task) => task.status !== "blocked").flatMap((task) => task.criteria),
    ...output.tasks.flatMap((task) => task.criteria),
  ])
  const missingRequired = goal.acceptanceCriteria.find(
    (criterion) => criterion.required && !effectiveCriteria.has(criterion.id),
  )
  if (missingRequired)
    return yield* invalid(`Required criterion ${missingRequired.id} is absent from the recovery graph`)
  const ordered = topological(output.tasks, [], new Set())
  if (!ordered) return yield* invalid("Architect Task graph contains a dependency cycle")
  const byKey = new Map(
    output.tasks.map((task) => [
      task.key,
      {
        id: taskID(goal.id, architectTask.id, task.key),
        title: task.title,
        instructions: task.instructions,
        dependsOn: task.dependsOn,
        role: task.role,
        isolation: task.isolation,
        criteria: task.criteria,
      },
    ]),
  )
  const collision = Array.from(byKey.values()).find((task) => byExistingID.has(task.id))
  if (collision) return yield* invalid(`Architect Task ID ${collision.id} already exists`)
  return {
    supersededTaskIDs: output.supersedes,
    tasks: ordered.map((task) => {
      const item = byKey.get(task.key)!
      return {
        ...item,
        dependsOn: item.dependsOn.map((dependency) => byKey.get(dependency)?.id ?? Work.TaskID.make(dependency)),
      } satisfies ValidatedTask
    }),
  } satisfies ValidatedReplan
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service

    return Service.of({
      run: Effect.fn("WorkArchitect.run")(function* (input) {
        const sessionID = input.attempt.sessionID
        if (!sessionID) return yield* new InvalidOutputError({ message: "Architect Attempt has no Session" })
        yield* sessions.prompt({
          id: promptID(input.attempt.id),
          sessionID,
          prompt: { text: prompt(input) },
          resume: false,
        })
        yield* sessions.resume(sessionID)
        const messages = yield* sessions.messages({ sessionID, limit: 20, order: "desc" })
        const response = messages.find((message) => message.type === "assistant")
        if (!response || response.type !== "assistant")
          return yield* new InvalidOutputError({ message: "Architect Session produced no assistant response" })
        const text = response.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n")
        if (!text) return yield* new InvalidOutputError({ message: "Architect response contained no text" })
        return yield* parse(text)
      }),
    })
  }),
)

function promptID(attemptID: Work.AttemptID) {
  return SessionMessage.ID.make(`msg_${attemptID.slice("attempt_".length)}`)
}

export function prompt(input: Input) {
  return [
    `Goal: ${input.goal.objective}`,
    `Replan request: ${input.task.instructions}`,
    `Acceptance criteria:\n${input.goal.acceptanceCriteria
      .map(
        (criterion) => `- ${criterion.id}: ${criterion.description} (${criterion.required ? "required" : "optional"})`,
      )
      .join("\n")}`,
    `Current durable Task graph:\n${input.tasks
      .filter((task) => task.id !== input.task.id)
      .map(
        (task) =>
          `- ${task.id} [${task.status}] role=${task.role} dependsOn=${task.dependsOn.join(",") || "none"} criteria=${task.criteria.join(",") || "none"}\n  ${task.title}: ${task.instructions}`,
      )
      .join("\n")}`,
    `Latest failure evaluations:\n${JSON.stringify(
      input.evaluations.slice(-30).map((evaluation) => ({
        taskID: evaluation.taskID,
        criterionID: evaluation.criterionID,
        verdict: evaluation.verdict,
        findings: evaluation.findings,
      })),
    )}`,
    `Verified Task Handoffs:\n${JSON.stringify(
      input.handoffs.map((handoff) => ({
        id: handoff.id,
        taskID: handoff.taskID,
        producer: handoff.producer,
        summary: handoff.summary,
        items: handoff.items,
        evidenceIDs: handoff.evidenceIDs,
        digest: handoff.digest,
      })),
    )}`,
    `Available Role Contracts:\n${WorkRole.guidance(input.goal.roleContracts ?? WorkRole.contracts)}`,
    "Produce an additive recovery DAG. Supersede only blocked execution Tasks, preserve all of their criterion assignments on replacement Tasks, and depend only on replacement keys or already completed/superseded Tasks. Assign an organization role only where its permissions and responsibility match the recovery work. Do not repeat a failed approach without addressing its evidence.",
    'Return JSON with this exact shape: {"supersedes":["task_..."],"tasks":[{"key":"stable-local-key","title":"...","instructions":"...","dependsOn":["other-key-or-completed-task-id"],"role":"one ID from the supplied Role Contracts","isolation":"shared|worktree","criteria":["criterion_..."]}]}',
    "Use 1-12 Tasks in normal cases. Do not wrap JSON in markdown or add commentary.",
  ].join("\n\n")
}

function taskID(goalID: Work.GoalID, architectTaskID: Work.TaskID, key: string) {
  return Work.TaskID.make(`task_${hash(`${goalID}:${architectTaskID}:${key}`).slice(0, 24)}`)
}

function topological(
  remaining: ReadonlyArray<Work.PlanTask>,
  ordered: ReadonlyArray<Work.PlanTask>,
  completed: ReadonlySet<string>,
): ReadonlyArray<Work.PlanTask> | undefined {
  if (remaining.length === 0) return ordered
  const keys = new Set(remaining.map((task) => task.key))
  const ready = remaining.filter((task) =>
    task.dependsOn.every((dependency) => !keys.has(dependency) || completed.has(dependency)),
  )
  if (ready.length === 0) return undefined
  const readyKeys = new Set(ready.map((task) => task.key))
  return topological(
    remaining.filter((task) => !readyKeys.has(task.key)),
    [...ordered, ...ready],
    new Set([...completed, ...readyKeys]),
  )
}

function invalid(message: string) {
  return Effect.fail(new InvalidOutputError({ message }))
}

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

export const node = makeGlobalNode({ service: Service, layer, deps: [SessionV2.node] })
