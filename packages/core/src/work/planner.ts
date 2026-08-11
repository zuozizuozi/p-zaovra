export * as WorkPlanner from "./planner"

import { Work } from "@zaovra-ai/schema/work"
import { Location } from "@zaovra-ai/schema/location"
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

export class InvalidOutputError extends Schema.TaggedErrorClass<InvalidOutputError>()("WorkPlanner.InvalidOutput", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly run: (
    input: Input,
  ) => Effect.Effect<Work.PlanOutput, InvalidOutputError | SessionV2.Error | SessionRunner.RunError>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkPlanner") {}

const PlanJson = Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Work.PlanOutput))
const decode = Schema.decodeUnknownEffect(PlanJson)

export const parse = Effect.fn("WorkPlanner.parse")(function* (text: string) {
  const normalized = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
  return yield* decode(normalized).pipe(
    Effect.mapError(() => new InvalidOutputError({ message: "Planner did not return valid structured JSON" })),
  )
})

export const validate = Effect.fn("WorkPlanner.validate")(function* (goal: Work.GoalInfo, output: Work.PlanOutput) {
  const roleContracts = goal.roleContracts ?? WorkRole.contracts
  if (output.tasks.length === 0) return yield* invalid("Planner returned an empty Task graph")
  if (output.tasks.length > 24) return yield* invalid("Planner returned more than 24 Tasks")
  const keys = output.tasks.map((task) => task.key)
  if (new Set(keys).size !== keys.length) return yield* invalid("Planner Task keys must be unique")
  const knownKeys = new Set(keys)
  const invalidDependency = output.tasks.find(
    (task) =>
      new Set(task.dependsOn).size !== task.dependsOn.length ||
      task.dependsOn.includes(task.key) ||
      task.dependsOn.some((dependency) => !knownKeys.has(dependency)),
  )
  if (invalidDependency) return yield* invalid(`Planner Task ${invalidDependency.key} has invalid dependencies`)
  const knownCriteria = new Set(goal.acceptanceCriteria.map((criterion) => criterion.id))
  const invalidCriterion = output.tasks.find(
    (task) =>
      new Set(task.criteria).size !== task.criteria.length ||
      task.criteria.some((criterionID) => !knownCriteria.has(criterionID)),
  )
  if (invalidCriterion) return yield* invalid(`Planner Task ${invalidCriterion.key} has invalid criteria`)
  const invalidRole = output.tasks.find((task) => !WorkRole.get(task.role, roleContracts))
  if (invalidRole)
    return yield* invalid(`Planner Task ${invalidRole.key} uses unknown Role Contract ${invalidRole.role}`)
  const invalidIsolation = output.tasks.find(
    (task) => !WorkRole.allowsIsolation(task.role, task.isolation, roleContracts),
  )
  if (invalidIsolation)
    return yield* invalid(
      `Role ${invalidIsolation.role} does not permit ${invalidIsolation.isolation} isolation for Task ${invalidIsolation.key}`,
    )
  const assigned = new Set(output.tasks.flatMap((task) => task.criteria))
  const uncovered = goal.acceptanceCriteria.find((criterion) => criterion.required && !assigned.has(criterion.id))
  if (uncovered) return yield* invalid(`Required criterion ${uncovered.id} is not assigned to any Task`)

  const byKey = new Map(
    output.tasks.map((task) => [
      task.key,
      {
        id: taskID(goal.id, task.key),
        title: task.title,
        instructions: task.instructions,
        dependsOn: task.dependsOn,
        role: task.role,
        isolation: task.isolation,
        criteria: task.criteria,
      },
    ]),
  )
  const ordered = topological(output.tasks, [], new Set())
  if (!ordered) return yield* invalid("Planner Task graph contains a dependency cycle")
  return ordered.map((task) => {
    const item = byKey.get(task.key)!
    return {
      ...item,
      dependsOn: item.dependsOn.map((dependency) => byKey.get(dependency)!.id),
    } satisfies ValidatedTask
  })
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service

    return Service.of({
      run: Effect.fn("WorkPlanner.run")(function* (input) {
        const sessionID = input.attempt.sessionID
        if (!sessionID) return yield* new InvalidOutputError({ message: "Planner Attempt has no Session" })
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
          return yield* new InvalidOutputError({ message: "Planner Session produced no assistant response" })
        const text = response.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n")
        if (!text) return yield* new InvalidOutputError({ message: "Planner response contained no text" })
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
    `Acceptance criteria:\n${input.goal.acceptanceCriteria
      .map(
        (criterion) => `- ${criterion.id}: ${criterion.description} (${criterion.required ? "required" : "optional"})`,
      )
      .join("\n")}`,
    `Available Role Contracts:\n${WorkRole.guidance(input.goal.roleContracts ?? WorkRole.contracts)}`,
    "Inspect the project and decompose the Goal into a small dependency DAG. Prefer the organization roles pm, architect, developer, qa, and security when their independent responsibility materially improves the result; do not create ceremonial roles. Use explore for narrow read-only research and retain build/general only for backward-compatible general execution. Request worktree isolation only for independent write Tasks; the runtime may conservatively fall back to shared execution when the project is dirty or not backed by Git.",
    'Return JSON with this exact shape: {"tasks":[{"key":"stable-local-key","title":"...","instructions":"...","dependsOn":["other-key"],"role":"one ID from the supplied Role Contracts","isolation":"shared|worktree","criteria":["criterion_..."]}]}',
    "Use 1-12 Tasks in normal cases, reference only the supplied criterion IDs, cover every required criterion, and do not wrap JSON in markdown.",
  ].join("\n\n")
}

function taskID(goalID: Work.GoalID, key: string) {
  return Work.TaskID.make(`task_${hash(`${goalID}:${key}`).slice(0, 24)}`)
}

function topological(
  remaining: ReadonlyArray<Work.PlanTask>,
  ordered: ReadonlyArray<Work.PlanTask>,
  completed: ReadonlySet<string>,
): ReadonlyArray<Work.PlanTask> | undefined {
  if (remaining.length === 0) return ordered
  const ready = remaining.filter((task) => task.dependsOn.every((dependency) => completed.has(dependency)))
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
