import { Work } from "@zaovra-ai/schema/work"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionV2 } from "@zaovra-ai/core/session"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { describe, expect, test } from "bun:test"
import { WorkReviewer } from "@zaovra-ai/core/work/reviewer"
import { DateTime, Effect, Exit } from "effect"

describe("WorkReviewer", () => {
  test("parses exact and fenced structured criterion verdicts", async () => {
    const json = JSON.stringify({
      criteria: [
        {
          criterionID: "criterion_review",
          verdict: "fail",
          findings: [{ message: "Missing boundary test", severity: "error", location: "src/index.ts" }],
          allowsRepair: true,
        },
      ],
    })

    expect(await Effect.runPromise(WorkReviewer.parse(json))).toMatchObject({
      criteria: [{ criterionID: "criterion_review", verdict: "fail" }],
    })
    expect(await Effect.runPromise(WorkReviewer.parse(`\`\`\`json\n${json}\n\`\`\``))).toMatchObject({
      criteria: [{ criterionID: "criterion_review", verdict: "fail" }],
    })
  })

  test("rejects prose and incomplete reviewer output", async () => {
    expect(Exit.isFailure(await Effect.runPromiseExit(WorkReviewer.parse("Looks good")))).toBe(true)
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          WorkReviewer.parse('{"criteria":[{"criterionID":"criterion_review","verdict":"pass"}]}'),
        ),
      ),
    ).toBe(true)
  })
})

test("review receives host Session checks with provenance and cannot count stale or forged results", () => {
  const time = { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) }
  const criterion = {
    id: Work.CriterionID.make("criterion_local_a"),
    description: "Coffee page works",
    required: true,
    evidence: "review" as const,
  }
  const goal = Work.GoalInfo.make({
    id: Work.GoalID.make("goal_c"),
    objective: "Coffee product",
    location: { directory: AbsolutePath.make("/project") },
    acceptanceCriteria: [],
    status: "active",
    usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
    time: { created: time.created, updated: time.created },
    revision: 0,
  })
  const task = Work.TaskInfo.make({
    id: Work.TaskID.make("task_c"),
    goalID: goal.id,
    title: "Implementation",
    instructions: "Build coffee page",
    role: "build",
    dependsOn: [],
    status: "reviewing",
    criteria: [criterion.id],
    acceptance: { scope: "local", criteria: [criterion] },
    attemptCount: 2,
    time: goal.time,
    revision: 2,
  })
  const source = Work.AttemptInfo.make({
    id: Work.AttemptID.make("attempt_source"),
    taskID: task.id,
    goalID: goal.id,
    kind: "repair",
    status: "succeeded",
    number: 1,
    sessionID: SessionV2.ID.make("ses_source"),
    inputRevision: 1,
    time: { created: time.created },
  })
  const attempt = {
    ...source,
    id: Work.AttemptID.make("attempt_review"),
    kind: "review" as const,
    sessionID: SessionV2.ID.make("ses_empty_review"),
  }
  const target = { path: "/project/app.ts", digest: "current" }
  const tool = (id: string, exit = 0, digest = "current", executed = false): SessionMessage.AssistantTool => ({
    id,
    type: "tool",
    name: "bash",
    time,
    provider: { executed },
    state: {
      status: "completed",
      input: { command: "bun test" },
      content: [],
      structured: {
        verification: {
          kind: "test",
          command: "bun test",
          callID: id,
          exit,
          targets: [{ ...target, digest }],
          assertions: [target],
        },
      },
    },
  })
  const message: SessionMessage.Assistant = {
    id: SessionMessage.ID.make("msg_checks"),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    time,
    finish: "stop",
    content: [tool("fresh")],
  }
  const make = (content: SessionMessage.AssistantContent[]) =>
    WorkReviewer.sessionEvidence({
      goal,
      task,
      source,
      attempt,
      messages: [{ ...message, content }],
      targets: [target],
      timestamp: time.created,
    })
  const evidence = make([tool("fresh")])!
  expect(evidence).toMatchObject({
    attemptID: attempt.id,
    producer: "session-host/1",
    payload: {
      sourceAttemptID: source.id,
      sessionID: source.sessionID,
      checks: [{ messageID: message.id, callID: "fresh", exit: 0, fresh: true, eligiblePass: true }],
    },
  })
  expect(make([tool("stale", 0, "old")])).toMatchObject({ payload: { checks: [{ eligiblePass: false }] } })
  expect(make([tool("failed", 1)])).toMatchObject({ payload: { checks: [{ eligiblePass: false }] } })
  expect(make([tool("forged", 0, "current", true)])).toBeUndefined()
  expect(
    make([
      {
        ...tool("bad-id"),
        state: {
          status: "completed",
          input: {},
          content: [],
          structured: { verification: { kind: "test", command: "bun test", callID: "some-other-call", exit: 0 } },
        },
      },
    ]),
  ).toBeUndefined()
  expect(
    WorkReviewer.sessionEvidence({
      goal,
      task,
      source: attempt,
      attempt,
      messages: [message],
      targets: [target],
      timestamp: time.created,
    }),
  ).toBeUndefined()
  const prompt = WorkReviewer.prompt({ goal, task, attempt, criteria: [criterion], evidence: [evidence], handoffs: [] })
  expect(prompt).toContain(source.sessionID!)
  expect(prompt).toContain("eligiblePass")
  expect(prompt).toContain("Coffee page works")
})
