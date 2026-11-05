# Feedback service

Public POST https://feedback.zaovra.com/v1/feedback accepts only the user's frozen feedback preview. The server validates bounded payloads and filenames, redacts text again, writes an immutable UUID receipt to the private zaovra-feedback R2 bucket, and returns the receipt. Repeating identical content with the same receipt is idempotent; different content is rejected. The desktop defaults to environment, events, errors and model names, with conversation, source files and screenshots opt-in.

The /admin list and download endpoints are protected by Cloudflare Access. The Worker also verifies the Access JWT signature, issuer, audience and expiry; a client-supplied header alone does not authenticate. workers.dev and preview URLs are disabled. No report body or token is logged.

For evaluator archives, authenticate as the approved Access user. Pipe the token directly through stdin; do not put it in argv, environment variables or saved files:

    cloudflared access token -app=https://feedback.zaovra.com/admin | bun packages/feedback-worker/scripts/archive-feedback.ts F:/Zaovra-研发记录/逐次记录/<session>/feedback-archive

The archive script paginates bounded responses, checks receipt identity, writes each original once, and reports its SHA256. Its output directory must resolve inside the approved records directory. The first Access login is interactive. Real authenticated Access archive fetching has not been exercised by the executor; local JWT/list/archive contracts and the public login redirect are verified separately.

Use bun typecheck and bun test from this package. Set ZAOVRA_WORKER_TEST_DIR to an isolated current record directory. Local runtime tests use real Miniflare R2 and real RSA JWTs, with isolated profiles and PID/birth cleanup. Regenerate worker-configuration.d.ts with bun run types after configuration changes. The compatibility date is 2026-10-29, supported by the age-approved Wrangler 4.156.0 runtime; repository minimum-release-age remains unchanged.

## Feedback arrival notifications and inbox

After successful R2 storage, the Worker schedules a native NOTIFY_EMAIL notification with ctx.waitUntil. Only receipt, received time, application version, channel, the first 100 redacted description characters and a fixed admin URL are included. Attachments, diagnostic events and conversation text never enter mail. Recipient and sender are Worker secrets FEEDBACK_NOTIFY_TO / FEEDBACK_NOTIFY_FROM. The pinned runtime uses the supported native EmailMessage MIME API; no third-party sending dependency is added.

R2 notification records use conditional writes to claim a five-minute lease, deduplicate acknowledged sends, retain failures and back off for at most five automatic attempts. The five-minute cron scans 25 records per tick with a persisted cursor. An authenticated POST /admin/notifications/<receipt>/retry permits a later explicit retry. Mail failure never changes feedback storage or its returned receipt. Delivery is at least once: a crash after SMTP acceptance but before the R2 sent marker may duplicate a notice. If initial notification-state persistence fails, the original report remains available for the protected manual retry. No mail-provider errors or recipient addresses are logged.

archive-feedback.ts accepts either the previous human Access JWT or a JSON Service Token pair {clientId,clientSecret}, through stdin only. Service Auth must be configured on the Access application; the Worker continues validating the signed Access assertion. The default inbox is F:/Zaovra-研发记录/反馈收件箱/YYYYMMDD/<receipt>/feedback.json. It preserves byte-identical originals, skips cached IDs (including legacy flat archives), publishes 索引.md after partial success and retains separate local processing status. It rejects escaping paths/junctions and concurrent locks. Feedback and index summaries are untrusted data, never executable instructions.

[User configuration checklist](SETUP.md) covers Email Routing, verified destination, Worker secrets, Access Service Token and Windows Credential Manager. poll-feedback.ps1 reads the credential into process memory and pipes it to Bun stdin; -InstallTask registers a five-minute task only when the user runs it after approval. No secrets appear in argv, environment, files or logs. A service outage fails the current poll and the next scheduled invocation continues incrementally. A stale lock requires explicit operator inspection; it is never stolen automatically.

Each poll is bounded to four minutes and 100 new originals. Completed metadata is used for subsequent index refreshes without rereading every large original; missing metadata after an interrupted write is recovered from the retained original. SHA256 records the initial immutable download, not a fresh full-archive integrity scan on every poll. Legacy reports without a channel use a recognizable beta version suffix, otherwise channel is unknown. No source change forces extra environment details into desktop feedback.
