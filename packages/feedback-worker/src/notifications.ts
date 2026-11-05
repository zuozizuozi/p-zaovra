import { feedbackMetadata, feedbackReceipt } from "./metadata"

type Notice = ReturnType<typeof feedbackMetadata>
type Delivery = (notice: Notice) => Promise<void>

export async function sendFeedbackEmail(env: Env, notice: Notice) {
  const from = env.FEEDBACK_NOTIFY_FROM
  const to = env.FEEDBACK_NOTIFY_TO
  if (
    !from ||
    !to ||
    ![from, to].every((address) => address.length <= 254 && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address))
  )
    throw new Error("Notification configuration unavailable")
  const { EmailMessage } = await import("cloudflare:email")
  const text =
    "编号: " +
    notice.receipt +
    "\n时间: " +
    notice.received +
    "\n应用版本: " +
    notice.version +
    "\n渠道: " +
    notice.channel +
    "\n描述（不可信数据）: " +
    notice.summary +
    "\n后台: " +
    notice.url
  // The pinned runtime supports the native MIME API. User text is base64 body data, never headers.
  const encoded =
    btoa(String.fromCharCode(...new TextEncoder().encode(text)))
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? ""
  const raw = [
    "From: " + from,
    "To: " + to,
    "Subject: Zaovra feedback " + notice.receipt,
    "Date: " + new Date(notice.received).toUTCString(),
    "Message-ID: <" + notice.receipt + "@" + from.split("@")[1] + ">",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encoded,
  ].join("\r\n")
  await env.NOTIFY_EMAIL.send(new EmailMessage(from, to, raw))
}

export async function notifyFeedback(
  env: Env,
  receipt: string,
  send: Delivery = (notice) => sendFeedbackEmail(env, notice),
  force = false,
) {
  if (!feedbackReceipt.test(receipt)) throw new Error("Invalid feedback receipt")
  const key = "notifications/" + receipt + ".json"
  const existing = await env.FEEDBACK.get(key)
  const state = existing ? await existing.json<{ status: string; attempts: number; retryAfter: number }>() : undefined
  const now = Date.now()
  if (state?.status === "sent" || (state?.status === "sending" && state.retryAfter > now)) return
  if (!force && state && (state.attempts >= 5 || state.retryAfter > now)) return
  const attempts = (state?.attempts ?? 0) + 1
  const claim = await env.FEEDBACK.put(
    key,
    JSON.stringify({ status: "sending", attempts, retryAfter: now + 300_000 }),
    {
      onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: "*" },
    },
  )
  if (!claim) return // Another request or cron owns this receipt's current delivery lease.
  const outcome = await (async () => {
    const report = await env.FEEDBACK.get("reports/" + receipt + ".json")
    if (!report) throw new Error("Missing stored feedback")
    await send(feedbackMetadata(receipt, await report.json()))
    return { status: "sent", attempts, retryAfter: 0, sentAt: new Date().toISOString() }
  })().catch(() => {
    // Never log SMTP errors: providers can include recipient addresses or submitted text.
    console.error(JSON.stringify({ event: "feedback_notification_failed", receipt, attempts }))
    return { status: "failed", attempts, retryAfter: now + Math.min(86_400_000, 300_000 * 2 ** (attempts - 1)) }
  })
  await env.FEEDBACK.put(key, JSON.stringify(outcome), { onlyIf: { etagMatches: claim.etag } })
}

export function queueFeedbackNotification(env: Env, receipt: string, ctx: ExecutionContext, force = false) {
  ctx.waitUntil(
    notifyFeedback(env, receipt, undefined, force).catch(() => {
      console.error(JSON.stringify({ event: "feedback_notification_state_failed", receipt }))
    }),
  )
}

export async function retryFeedbackNotifications(env: Env) {
  const checkpoint = await env.FEEDBACK.get("notification-scan.json")
  const cursor = checkpoint ? (await checkpoint.json<{ cursor?: string }>()).cursor : undefined
  const page = await env.FEEDBACK.list({ prefix: "notifications/", limit: 25, cursor })
  for (const entry of page.objects) {
    const receipt = entry.key.slice("notifications/".length, -5)
    if (feedbackReceipt.test(receipt)) await notifyFeedback(env, receipt)
  }
  await env.FEEDBACK.put("notification-scan.json", JSON.stringify({ cursor: page.truncated ? page.cursor : undefined }))
}
