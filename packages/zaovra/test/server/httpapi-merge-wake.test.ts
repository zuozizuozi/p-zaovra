import { $, sleep } from "bun"
import { expect, test } from "bun:test"
import path from "node:path"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

test("approving an idle pending merge wakes the durable backend without UI resume", async () => {
  await using tmp = await tmpdir({ git: true })
  const isolated = path.join(tmp.path, "isolated")
  let calls = 0
  await using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++
      const data = {
        id: "merge-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta: { role: "assistant", content: '{"criteria":[]}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
      return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  await Bun.write(path.join(tmp.path, ".gitignore"), "isolated/\n")
  await Bun.write(path.join(tmp.path, "base.txt"), "base")
  await Bun.write(
    path.join(tmp.path, "zaovra.json"),
    JSON.stringify({
      model: "merge-fixture/fixture",
      provider: {
        "merge-fixture": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
          models: { fixture: { limit: { context: 32000, output: 1024 } } },
        },
      },
    }),
  )
  await $`git add .`.cwd(tmp.path).quiet()
  await $`git -c user.name=Test -c user.email=test@example.test commit -m fixture`.cwd(tmp.path).quiet()
  await $`git worktree add --detach ${isolated}`.cwd(tmp.path).quiet()
  await Bun.write(path.join(isolated, "feature.txt"), "isolated change\n".repeat(6000))
  const app = Server.Default().app
  const headers = { "content-type": "application/json", "x-zaovra-directory": encodeURIComponent(tmp.path) }
  const id = `goal_merge_${Date.now()}`
  const request = async (url: string, body?: unknown) => {
    const response = await app.request(url, {
      headers,
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    })
    expect(response.status, await response.clone().text()).toBeLessThan(300)
    return response
  }
  const created = await (
    await request("/api/work", {
      id,
      location: { directory: tmp.path },
      objective: "Merge fixture",
      acceptanceCriteria: [],
      tasks: [{ title: "Isolated", instructions: "Return a short response", location: { directory: isolated } }],
    })
  ).json()
  const task = created.data.tasks[0].id
  await request(`/api/work/${id}/resume`, {})
  const deadline = Date.now() + 20000
  let pending = false
  while (Date.now() < deadline) {
    const state = await (await request(`/api/work/${id}`)).json()
    const active = await (await request("/api/work/active")).json()
    if (state.data.tasks[0].status === "merging" && !active.data[id]) {
      pending = true
      break
    }
    await sleep(50)
  }
  expect(pending).toBe(true)
  const review = await (await request(`/api/work/${id}/merge/${task}`)).json()
  const before = calls
  await request(`/api/work/${id}/merge/${task}`, { token: review.token, approved: true })
  let completed = false
  while (Date.now() < deadline) {
    const state = await (await request(`/api/work/${id}`)).json()
    if (state.data.goal.status === "completed") {
      completed = true
      break
    }
    await sleep(50)
  }
  expect(completed).toBe(true)
  expect((await Bun.file(path.join(tmp.path, "feature.txt")).text()).replaceAll("\r\n", "\n")).toBe(
    "isolated change\n".repeat(6000),
  )
  expect(calls).toBe(before)
}, 45000)
