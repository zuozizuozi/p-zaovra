import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SessionMessage, SessionV2Info } from "@zaovra-ai/sdk/v2/client"
import { adaptSessionMessages } from "../../src/context/v2-session-adapter"
import { inspectTurnDeliverables, turnDeliverables } from "../../src/utils/turn-deliverables"
import { inspectArtifactFile } from "../../../desktop-app/src/main/artifact-save"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error("unsafe cleanup")
    await rm(root, { recursive: true, force: true })
  }
})

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "delivery-window815-"))
  roots.push(root)
  return root
}

async function script(root: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `await Bun.write(${JSON.stringify(path.join(root, "report.pdf"))},new Uint8Array([37,80,68,70,0,255]))`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  expect(code, err).toBe(0)
  return inspectArtifactFile({ target: "report.pdf", directory: root })
}

function declared(root: string, start: number, finish?: number, streaming = false) {
  const session: SessionV2Info = {
    id: "session815",
    projectID: "project",
    agent: "build",
    model: { id: "local", providerID: "fixture" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: start, updated: finish ?? start },
    title: "815",
    location: { directory: root },
  }
  const messages: SessionMessage[] = [
    { id: "user815", type: "user", text: "make report", time: { created: start } },
    {
      id: "answer815",
      type: "assistant",
      agent: "build",
      model: session.model!,
      time: { created: start + 1, completed: streaming ? start + 2 : finish },
      content: [{ id: "declaration", type: "text", text: "[Report](report.pdf)" }],
    },
  ]
  if (streaming)
    messages.push({
      id: "stream815",
      type: "assistant",
      agent: "build",
      model: session.model!,
      time: { created: start + 3 },
      content: [{ id: "streaming", type: "text", text: "Generating report…" }],
    })
  const rows = adaptSessionMessages(session, messages)
  return turnDeliverables({
    messages: rows.map((r) => r.message),
    parts: Object.fromEntries(rows.map((r) => [r.message.id, r.parts])),
    messageID: "user815",
    directory: root,
  })
}

const inspect = (root: string, items: ReturnType<typeof turnDeliverables>) =>
  inspectTurnDeliverables(items, (target) => inspectArtifactFile({ target, directory: root }))

test("815 a closed turn cannot acquire its missing declaration when a script creates it later", async () => {
  const root = await project()
  const finish = Date.now() - 5000
  const items = declared(root, finish - 5000, finish)
  expect(await inspect(root, items)).toEqual({ "report.pdf": false })
  const info = await script(root)
  expect(info.created).toBeGreaterThan(finish)
  expect(await inspect(root, items)).toEqual({ "report.pdf": false })
  expect(await inspect(root, declared(root, finish - 5000, finish))).toEqual({ "report.pdf": false })
})

test("815 a script file inside the completed window qualifies, but later modifications do not", async () => {
  const root = await project()
  const info = await script(root)
  const finish = Math.ceil(Math.max(info.created, info.modified)) + 1000
  const items = declared(root, finish - 20_000, finish)
  expect(await inspect(root, items)).toEqual({ "report.pdf": true })
  await utimes(path.join(root, "report.pdf"), new Date(finish), new Date(finish))
  expect(await inspect(root, items)).toEqual({ "report.pdf": true })
  await utimes(path.join(root, "report.pdf"), new Date(finish + 1000), new Date(finish + 1000))
  expect(await inspect(root, items)).toEqual({ "report.pdf": false })
})

test("815 an active assistant keeps the turn open after an earlier provider message completed", async () => {
  const root = await project()
  const info = await script(root)
  const finish = Math.ceil(Math.max(info.created, info.modified)) + 1000
  const start = finish - 20_000
  const active = declared(root, start, undefined, true)
  expect(await inspect(root, active)).toEqual({ "report.pdf": true })
  expect(await inspect(root, declared(root, start, finish))).toEqual({ "report.pdf": true })
})
