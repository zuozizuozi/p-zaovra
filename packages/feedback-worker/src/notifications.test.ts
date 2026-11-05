import { afterAll, beforeAll, expect, test } from "bun:test"
import { getPlatformProxy } from "wrangler"
import { notifyFeedback } from "./notifications"

const root = process.env.ZAOVRA_WORKER_TEST_DIR
if (!root) throw new Error("Use the current isolated record directory")
let platform: Awaited<ReturnType<typeof getPlatformProxy<Env>>>
beforeAll(async () => {
  platform = await getPlatformProxy<Env>({
    configPath: "wrangler.jsonc",
    persist: { path: root + "/notifications-r2" },
  })
}, 30_000)
afterAll(async () => {
  await platform?.dispose()
})

async function stored() {
  const receipt = crypto.randomUUID()
  await platform.env.FEEDBACK.put(
    "reports/" + receipt + ".json",
    JSON.stringify({
      received: new Date().toISOString(),
      snapshot: {
        text: JSON.stringify({ reportID: receipt, description: "A report", environment: { version: "0.1.1-beta.2" } }),
      },
    }),
  )
  return receipt
}

test("real local R2 delivery claims deduplicate concurrent sends and acknowledged retries", async () => {
  const receipt = await stored()
  let sends = 0
  const send = async () => {
    sends++
    await Bun.sleep(20)
  }
  await Promise.all([notifyFeedback(platform.env, receipt, send), notifyFeedback(platform.env, receipt, send)])
  await notifyFeedback(platform.env, receipt, send, true)
  expect(sends).toBe(1)
  expect(await (await platform.env.FEEDBACK.get("notifications/" + receipt + ".json"))?.json()).toMatchObject({
    status: "sent",
    attempts: 1,
  })
})

test("delivery failure preserves stored feedback, is durable and can be explicitly retried", async () => {
  const receipt = await stored()
  await notifyFeedback(platform.env, receipt, async () => {
    throw new Error("recipient-private")
  })
  expect(await (await platform.env.FEEDBACK.get("notifications/" + receipt + ".json"))?.json()).toMatchObject({
    status: "failed",
    attempts: 1,
  })
  expect(await platform.env.FEEDBACK.head("reports/" + receipt + ".json")).not.toBeNull()
  let sends = 0
  const send = async () => {
    sends++
  }
  await notifyFeedback(platform.env, receipt, send)
  expect(sends).toBe(0)
  await notifyFeedback(platform.env, receipt, send, true)
  expect(sends).toBe(1)
  expect(await (await platform.env.FEEDBACK.get("notifications/" + receipt + ".json"))?.json()).toMatchObject({
    status: "sent",
    attempts: 2,
  })
})

test("automatic retries stop after five attempts; an explicit authenticated retry remains possible", async () => {
  const receipt = await stored()
  await platform.env.FEEDBACK.put(
    "notifications/" + receipt + ".json",
    JSON.stringify({ status: "failed", attempts: 5, retryAfter: 0 }),
  )
  let sends = 0
  const send = async () => {
    sends++
  }
  await notifyFeedback(platform.env, receipt, send)
  expect(sends).toBe(0)
  await notifyFeedback(platform.env, receipt, send, true)
  expect(sends).toBe(1)
})

test("an expired delivery lease is recovered; missing email configuration cannot erase feedback", async () => {
  const receipt = await stored()
  await platform.env.FEEDBACK.put(
    "notifications/" + receipt + ".json",
    JSON.stringify({ status: "sending", attempts: 1, retryAfter: 0 }),
  )
  await notifyFeedback(platform.env, receipt, async () => {})
  expect(await (await platform.env.FEEDBACK.get("notifications/" + receipt + ".json"))?.json()).toMatchObject({
    status: "sent",
    attempts: 2,
  })
  const missing = await stored()
  await notifyFeedback(platform.env, missing)
  expect(await (await platform.env.FEEDBACK.get("notifications/" + missing + ".json"))?.json()).toMatchObject({
    status: "failed",
  })
  expect(await platform.env.FEEDBACK.head("reports/" + missing + ".json")).not.toBeNull()
})

test("205 expanded accepted records send through real local R2 once without metadata failures", async () => {
  const receipt = crypto.randomUUID()
  const text = JSON.stringify({ reportID: receipt, description: "扩展反馈", extra: Array(5000).fill(0) }, null, 2)
  expect(text.length).toBeGreaterThan(32_000)
  await platform.env.FEEDBACK.put(
    "reports/" + receipt + ".json",
    JSON.stringify({ received: new Date().toISOString(), snapshot: { text } }),
  )
  let sends = 0
  await notifyFeedback(platform.env, receipt, async (notice) => {
    sends++
    expect(notice.summary).toBe("扩展反馈")
  })
  expect(sends).toBe(1)
  expect(await (await platform.env.FEEDBACK.get("notifications/" + receipt + ".json"))?.json()).toMatchObject({
    status: "sent",
    attempts: 1,
  })
})
test("205 invalid records are terminally isolated without repeated send attempts and allow explicit recovery", async () => {
  const receipt = crypto.randomUUID()
  await platform.env.FEEDBACK.put("reports/" + receipt + ".json", JSON.stringify({ received: "bad" }))
  let sends = 0
  const send = async () => {
    sends++
  }
  await notifyFeedback(platform.env, receipt, send)
  await notifyFeedback(platform.env, receipt, send)
  expect(sends).toBe(0)
  expect(await (await platform.env.FEEDBACK.get("notifications/" + receipt + ".json"))?.json()).toMatchObject({
    status: "invalid",
    attempts: 1,
  })
  await platform.env.FEEDBACK.put(
    "reports/" + receipt + ".json",
    JSON.stringify({
      received: new Date().toISOString(),
      snapshot: { text: JSON.stringify({ reportID: receipt, description: "修复原件" }) },
    }),
  )
  await notifyFeedback(platform.env, receipt, send, true)
  expect(sends).toBe(1)
  expect(await (await platform.env.FEEDBACK.get("notifications/" + receipt + ".json"))?.json()).toMatchObject({
    status: "sent",
    attempts: 2,
  })
})
