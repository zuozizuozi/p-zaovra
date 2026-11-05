import { createRemoteJWKSet, jwtVerify } from "jose"
import { Feedback } from "../../schema/src/feedback"
import { queueFeedbackNotification, retryFeedbackNotifications } from "./notifications"

const limit = 5_500_000
const receiptPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export async function boundedJSON(request: Request) {
  if (!request.body || Number(request.headers.get("content-length")) > limit) throw new Error("body_limit")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new Error("body_limit")
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(size)
  chunks.reduce((offset, chunk) => {
    bytes.set(chunk, offset)
    return offset + chunk.byteLength
  }, 0)
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
}

export function safeSnapshot(value: unknown) {
  if (!Feedback.validSnapshot(value)) throw new Error("invalid_snapshot")
  const report: unknown = JSON.parse(value.text)
  if (
    !report ||
    typeof report !== "object" ||
    !("reportID" in report) ||
    typeof report.reportID !== "string" ||
    !receiptPattern.test(report.reportID)
  )
    throw new Error("invalid_receipt")
  const text = Feedback.redact(value.text)
  // Reject truncation rather than silently storing an invalid report.json.
  JSON.parse(text)
  const files = value.files.map((file) => ({
    name: file.name,
    text: file.name === "report.json" ? text : Feedback.redact(file.text),
  }))
  return { receipt: report.reportID, snapshot: { text, files, ...(value.image ? { image: value.image } : {}) } }
}

async function authenticated(request: Request, env: Env) {
  const token = request.headers.get("cf-access-jwt-assertion")
  if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return false
  const keys = createRemoteJWKSet(new URL(env.ACCESS_TEAM_DOMAIN + "/cdn-cgi/access/certs"))
  return jwtVerify(token, keys, {
    issuer: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUD,
    algorithms: ["RS256"],
  }).then(
    () => true,
    () => false,
  )
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } })
}

const handler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true })
    if (url.pathname === "/v1/feedback" && request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return json({ error: "content_type" }, 415)
      const rate = await env.SUBMISSIONS.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" })
      if (!rate.success) return json({ error: "rate_limited" }, 429)
      const prepared = await boundedJSON(request)
        .then(safeSnapshot)
        .catch(() => undefined)
      if (!prepared) return json({ error: "invalid_or_oversized_report" }, 400)
      const body = JSON.stringify({ received: new Date().toISOString(), snapshot: prepared.snapshot })
      const digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(prepared.snapshot))),
        ),
      )
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")
      const key = "reports/" + prepared.receipt + ".json"
      const stored = await env.FEEDBACK.put(key, body, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
        customMetadata: { digest },
      })
      if (!stored && (await env.FEEDBACK.head(key))?.customMetadata?.digest !== digest)
        return json({ error: "receipt_conflict" }, 409)
      queueFeedbackNotification(env, prepared.receipt, ctx)
      return json({ receipt: prepared.receipt, submitted: true }, stored ? 201 : 200)
    }
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (!(await authenticated(request, env))) return json({ error: "access_required" }, 403)
      if (request.method === "GET" && url.pathname.startsWith("/admin/notifications/")) {
        const receipt = url.pathname.slice("/admin/notifications/".length)
        if (!receiptPattern.test(receipt)) return json({ error: "invalid_receipt" }, 400)
        const state = await env.FEEDBACK.get("notifications/" + receipt + ".json")
        return state
          ? json({ receipt, ...(await state.json<{ status: string; attempts: number; retryAfter: number }>()) })
          : json({ error: "not_found" }, 404)
      }
      if (
        request.method === "POST" &&
        url.pathname.startsWith("/admin/notifications/") &&
        url.pathname.endsWith("/retry")
      ) {
        const receipt = url.pathname.slice("/admin/notifications/".length, -"/retry".length)
        if (!receiptPattern.test(receipt)) return json({ error: "invalid_receipt" }, 400)
        if (!(await env.FEEDBACK.head("reports/" + receipt + ".json"))) return json({ error: "not_found" }, 404)
        queueFeedbackNotification(env, receipt, ctx, true)
        return json({ receipt, notification: "queued" }, 202)
      }
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405)
      if (url.pathname === "/admin/reports") {
        const cursor = url.searchParams.get("cursor") ?? undefined
        if (cursor && cursor.length > 2048) return json({ error: "invalid_cursor" }, 400)
        const page = await env.FEEDBACK.list({ prefix: "reports/", limit: 50, cursor })
        return json({
          reports: page.objects.map((object) => ({
            receipt: object.key.slice(8, -5),
            received: object.uploaded.toISOString(),
            bytes: object.size,
          })),
          cursor: page.truncated ? page.cursor : null,
        })
      }
      if (url.pathname.startsWith("/admin/report/")) {
        const id = url.pathname.slice("/admin/report/".length)
        if (!receiptPattern.test(id)) return json({ error: "invalid_receipt" }, 400)
        const object = await env.FEEDBACK.get("reports/" + id + ".json")
        return object
          ? new Response(object.body, {
              headers: {
                "content-type": "application/json",
                "cache-control": "no-store",
                "x-content-type-options": "nosniff",
                "content-disposition": 'attachment; filename="' + id + '.json"',
              },
            })
          : json({ error: "not_found" }, 404)
      }
      if (url.pathname === "/admin/app.js")
        return new Response(adminScript, {
          headers: {
            "content-type": "text/javascript",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        })
      if (url.pathname === "/admin" || url.pathname === "/admin/")
        return new Response(adminPage, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy":
              "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'",
            "x-frame-options": "DENY",
            "x-content-type-options": "nosniff",
          },
        })
      return json({ error: "not_found" }, 404)
    }
    return json({ error: "not_found" }, 404)
  },
} satisfies ExportedHandler<Env>

export default {
  fetch(request, env, ctx) {
    return handler.fetch(request, env, ctx).catch(() => json({ error: "temporarily_unavailable" }, 503))
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      retryFeedbackNotifications(env).catch(() => {
        console.error(JSON.stringify({ event: "feedback_notification_retry_failed" }))
      }),
    )
  },
} satisfies ExportedHandler<Env>

const adminPage = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Zaovra 反馈</title><style>body{font:16px system-ui;max-width:960px;margin:48px auto;padding:0 20px}li{padding:12px;border-bottom:1px solid #ddd}button{padding:8px 16px}a{color:#2456b8}</style><h1>Zaovra 反馈</h1><p id="status" role="status">正在读取…</p><ul id="reports"></ul><button id="more" hidden>更多</button><script src="/admin/app.js"></script></html>`

const adminScript = `let cursor;const status=document.getElementById('status'),list=document.getElementById('reports'),more=document.getElementById('more');async function load(){more.disabled=true;try{const response=await fetch('/admin/reports'+(cursor?'?cursor='+encodeURIComponent(cursor):''));if(!response.ok)throw Error('request failed');const page=await response.json();for(const report of page.reports){const item=document.createElement('li'),link=document.createElement('a');link.textContent=report.receipt;link.href='/admin/report/'+encodeURIComponent(report.receipt);item.append(link,document.createTextNode(' · '+report.received+' · '+report.bytes+' bytes'));list.append(item)}cursor=page.cursor;more.hidden=!cursor;status.textContent='已读取 '+list.children.length+' 条反馈'}catch{status.textContent='读取失败，请刷新或重新登录。'}finally{more.disabled=false}}more.onclick=load;load();`
