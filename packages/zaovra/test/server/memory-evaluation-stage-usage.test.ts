import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { rename } from "node:fs/promises"
import path from "node:path"
import { startEvaluationRelay, startEvaluationStageUsage } from "../../../../script/evaluation/memory/relay"
import { StageUsageHeader } from "../../../../script/evaluation/memory/stage-usage"
import { casePrompts, chains, prepare, change } from "../../../../script/evaluation/memory/cases"
import { gradePublish } from "../../../../script/evaluation/memory/build-publish"
import { tmpdir } from "../fixture/fixture"

test("physical attempts keep their original stage through retry, missing usage and rollover", async () => {
  await using tmp = await tmpdir()
  const journal = path.join(tmp.path, "usage.jsonl")
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let sends = 0
  const forwardedGrants: (string | null)[] = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      forwardedGrants.push(request.headers.get(StageUsageHeader))
      const attempt = ++sends
      if (attempt === 1) return new Response(null, { status: 503 })
      if (attempt === 3) {
        started.resolve()
        await release.promise
      }
      const usage = { choices: [], usage: { prompt_tokens: attempt * 10, completion_tokens: 5 } }
      return new Response(`data: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const relay = startEvaluationRelay({
    baseURL: `http://127.0.0.1:${upstream.port}/v1`,
    journal,
    apiKey: "upstream-fixture-secret",
    model: "test-model",
    protocol: "openai-chat",
    maxRequests: 6,
    maxRequestBytes: 4096,
    maxOutput: 64,
  })
  const send = (key?: string) =>
    fetch(relay.baseURL + "/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${relay.apiKey}`, ...(key ? { [StageUsageHeader]: key } : {}) },
      body: JSON.stringify({
        model: "test-model",
        stream: true,
        max_tokens: 32,
        messages: [{ role: "user", content: "private fixture prompt" }],
      }),
    })
  try {
    using usage = startEvaluationStageUsage(relay, {
      baseURL: relay.baseURL,
      apiKey: relay.apiKey,
      model: "test-model",
      protocol: "openai-chat",
    })
    using first = usage.open(1)
    expect((await send(first.key)).status).toBe(403)
    first.bindSession("ses_fixture1")
    expect((await send()).status).toBe(403)
    expect((await send(first.key)).status).toBe(503)
    expect(await (await send(first.key)).text()).toContain("completion_tokens")
    const running = send(first.key)
      .then((response) => response.text())
      .catch(() => undefined)
    await started.promise
    first[Symbol.dispose]()
    using second = usage.open(2)
    second.bindSession("ses_fixture2")
    expect((await send(first.key)).status).toBe(403)
    expect(await (await send(second.key)).text()).toContain("completion_tokens")
    second[Symbol.dispose]()
    release.resolve()
    await running
    const report = usage.summarize([
      { stage: 1, status: "completed" },
      { stage: 2, status: "failed" },
      { stage: 3, status: "not-run" },
    ])
    expect(report.stages).toMatchObject([
      {
        stage: 1,
        status: "partial",
        physicalRequests: 3,
        reportedRequests: 1,
        unknownRequests: 2,
        observed: { input: 20, output: 5, total: 25 },
        eligibleForCostComparison: false,
      },
      {
        stage: 2,
        status: "reported",
        outcome: "failed",
        observed: { input: 40, output: 5, total: 45 },
        eligibleForCostComparison: false,
      },
      { stage: 3, status: "not-run", observed: null, eligibleForCostComparison: false },
    ])
    expect(report.laterStages).toMatchObject({ reportedRequests: 1, eligibleForCostComparison: false })
    expect(report.fullChain).toMatchObject({
      physicalRequests: 4,
      unknownRequests: 2,
      eligibleForCostComparison: false,
    })
    expect(forwardedGrants).toEqual([null, null, null, null])
    const text = await Bun.file(journal).text()
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const admitted = records.filter((record) => record.phase === "admitted")
    const receipts = records.filter((record) => record.phase === "usage-observed")
    expect(new Set(admitted.map((request) => request.id)).size).toBe(4)
    expect(admitted.map(({ runID, stage, sessionID }) => [runID, stage, sessionID])).toEqual([
      [report.runID, 1, "ses_fixture1"],
      [report.runID, 1, "ses_fixture1"],
      [report.runID, 1, "ses_fixture1"],
      [report.runID, 2, "ses_fixture2"],
    ])
    expect(admitted[0].sha256).toBe(admitted[1].sha256)
    expect(receipts).toHaveLength(4)
    for (const stage of report.stages) {
      for (const request of stage.requests) {
        const admission = admitted.find((entry) => entry.id === request.id)
        const receipt = receipts.find((entry) => entry.id === request.id)
        expect(admission).toMatchObject({ runID: request.runID, stage: request.stage, sessionID: request.sessionID })
        expect(receipt).toMatchObject(request.usage)
        expect(records.indexOf(admission)).toBeLessThan(records.indexOf(receipt))
      }
    }
    for (const secret of [first.key, second.key, relay.apiKey, "upstream-fixture-secret", "private fixture prompt"])
      expect(text).not.toContain(secret)
  } finally {
    release.resolve()
    await relay.stop()
    await upstream.stop(true)
  }
})

test("v2 clarifies the shared S4 instruction and uses the old byte-exact publication oracle", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "fixture")
  const chain = await prepare(directory, "publish")
  const v1 = casePrompts(chain)
  expect(createHash("sha256").update(JSON.stringify(v1)).digest("hex")).toBe(
    "5c37f81285a4d26bf470c3db079514dea193d5c29f6a3f92770bb43af26b1857",
  )
  const v2 = casePrompts(chain, "byte-preserving-v2")
  expect(v2[3]).toContain("包括行尾换行状态")
  expect(v2.filter((prompt, i) => prompt !== v1[i])).toEqual([v2[3]!])
  expect(() => casePrompts(chains.find((fixture) => fixture.id === "billing")!, "byte-preserving-v2")).toThrow(
    "invalid-memory-case-version",
  )
  await Bun.write(path.join(directory, "published.txt"), "v1")
  await change(directory, "publish")
  const retired = path.join(directory, "retired-published.txt")
  await rename(path.join(directory, "published.txt"), retired)
  await Bun.write(path.join(directory, "validated.txt"), "sample")
  const input = {
    directory,
    stage: 4,
    turn: {
      admitted: true,
      promoted: true,
      active: false,
      pending: 0,
      assistants: 1,
      unsettled: 0,
      outcome: "completed" as const,
    },
    verifyTools: async () => "verified" as const,
  }
  expect(await gradePublish(input)).toMatchObject({ pass: true })
  for (const line of ["v1\n", "v1\r\n"]) {
    await Bun.write(retired, line)
    expect(await gradePublish(input)).toMatchObject({ pass: false, reason: "phase-artifacts-differ" })
  }
  await Bun.write(path.join(directory, "history.json"), JSON.stringify(chain.history))
  expect(await gradePublish({ ...input, stage: 5 })).toMatchObject({ pass: false, reason: "phase-artifacts-differ" })
})
