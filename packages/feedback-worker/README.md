# Feedback service

Public POST https://feedback.zaovra.com/v1/feedback accepts only the user's frozen feedback preview. The server validates bounded payloads and filenames, redacts text again, writes an immutable UUID receipt to the private zaovra-feedback R2 bucket, and returns the receipt. Repeating identical content with the same receipt is idempotent; different content is rejected. The desktop defaults to environment, events, errors and model names, with conversation, source files and screenshots opt-in.

The /admin list and download endpoints are protected by Cloudflare Access. The Worker also verifies the Access JWT signature, issuer, audience and expiry; a client-supplied header alone does not authenticate. workers.dev and preview URLs are disabled. No report body or token is logged.

For evaluator archives, authenticate as the approved Access user. Pipe the token directly through stdin; do not put it in argv, environment variables or saved files:

    cloudflared access token -app=https://feedback.zaovra.com/admin | bun packages/feedback-worker/scripts/archive-feedback.ts F:/Zaovra-研发记录/逐次记录/<session>/feedback-archive

The archive script paginates bounded responses, checks receipt identity, writes each original once, and reports its SHA256. Its output directory must resolve inside the approved records directory. The first Access login is interactive. Real authenticated Access archive fetching has not been exercised by the executor; local JWT/list/archive contracts and the public login redirect are verified separately.

Use bun typecheck and bun test from this package. Set ZAOVRA_WORKER_TEST_DIR to an isolated current record directory. Local runtime tests use real Miniflare R2 and real RSA JWTs, with isolated profiles and PID/birth cleanup. Regenerate worker-configuration.d.ts with bun run types after configuration changes. The compatibility date is 2026-10-29, supported by the age-approved Wrangler 4.156.0 runtime; repository minimum-release-age remains unchanged.
