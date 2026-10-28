export async function GET() {
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zaovra · 反馈 / Feedback</title>
<main><h1>反馈 Zaovra 问题</h1><p>请在桌面应用中打开“反馈问题”，或在输入框使用 /bug。本地预览后，可以保存诊断包或打开邮件草稿。</p>
<p>Open “Report a problem” in the desktop app, or enter /bug. Review the local report before saving or drafting an email.</p>
<p>旧版应用可手动邮件联系：<a href="mailto:support@zaovra.com">support@zaovra.com</a>。请勿发送 Key、令牌或未经检查的原始日志。</p>
<p>No report is submitted by opening this page. Never send credentials or unreviewed raw logs.</p></main></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'",
        "referrer-policy": "no-referrer",
      },
    },
  )
}
