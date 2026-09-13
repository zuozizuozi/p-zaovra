# Codex runtime comparison and implementation

Reviewed 2026-09-13 against Codex stable `rust-v0.154.0`. Zaovra is BYOK: changes must benefit supported providers through shared runtime behavior. No model-specific control flow, Astra-only context scheme, mandatory second-model approval, or new reasoning setting is introduced here.

## Reference mechanisms

- [Codex 0.154.0](https://github.com/openai/codex/releases/tag/rust-v0.154.0): execution lifecycle, saved permissions, live integrations, and concurrent clients.
- [Environment provisioning recovery](https://github.com/openai/codex/pull/42388): distinguish environment observation from starting/recovering an environment; later readiness can recover provisioning failure without late failures overwriting success.
- [Approval evidence consistency](https://github.com/openai/codex/pull/43442): approval evidence must match the user instructions it evaluated.
- [MCP catalog/client binding](https://github.com/openai/codex/pull/43031): catalog changes must remain bound to the client that will execute them.

These are comparison inputs, not claims that each mechanism was absent in Zaovra or has been ported in this pass.

## Implemented

### Shared shell execution

`SessionV2.shell` previously spawned directly through Node and accumulated stdout/stderr independently without a capture limit. It now uses `AppProcess.run` and the same `AppProcess.shellCommand` constructor as the Bash tool. The constructor centralizes shell selection defaults, noninteractive stdin, detached POSIX process groups, and a three-second force-kill grace. Explicit shell calls retain their own user-initiated authorization contract; they do not enter model tool permission prompts.

Explicit shell execution has a ten-minute timeout and a one-MiB combined-output capture bound. Captured beginning/end output survives nonzero exit and failure; omission is marked. Caller cancellation preserves interruption while writing a durable terminal shell record. Session stop and deletion also cancel currently owned explicit shells and wait for cleanup/settlement. A pre-aborted process request fails before spawning. This uses existing process cleanup and does not claim complete adversarial descendant containment or sandbox isolation.

Same-ID explicit shell calls are serialized through the existing process-local KeyedMutex. Exact completed retries do not execute again; changing the command under an existing ID fails. Unfinished durable shell records are not automatically replayed. Active shell ownership stays process-local and is not a restart-recovery promise. A cancellation signal prevents that shell from issuing a follow-up wake.

### Durable event observation

Active durable subscriptions now read at most 256 events per query and continue by sequence until caught up. The subscription is established before history reads. Local commit notifications still wake the reader immediately; an idle reader additionally checks the database every five seconds so another process's committed events do not require an unrelated local event to become visible. Cancellation releases the subscription and its scoped wait. This supports observation of shared storage, not distributed execution ownership or database replication.

### Approval validity and MCP registration ownership

Positive permission replies now reload configured rules before granting or saving an approval. A missing Session or a newly applicable deny settles the waiting request with a correction instead of executing it. Applying an always-allow reply to other pending requests is restricted to the replying Location; the process-global pending map must not let one Location apply its saved rules to another Location's waiters.

MCP discovery remains interruptible. Once discovery finishes, the active client is checked and registration replacement, owner assignment, and old-registration cleanup form one uninterruptible commit. This closes the cancellation gap between registering new tools and recording their cleanup owner, while retaining the existing per-server lock and catalog/client binding.

Existing-ID Session restoration was reviewed and retained: it adopts the stored Session before considering fresh-create arguments. This review does not establish new fork inheritance or semantic approval invalidation when user steering changes.

### Pre-Zed runtime follow-through (2026-09-14)

The tool registry now supplies a per-invocation raw byte sink owned by ToolOutputStore. Bash appends combined stdout/stderr before the one-MiB in-memory preview cap; settlement includes the managed log reference, including ordinary command failures. Explicit Session shell calls reuse the same capture implementation. Files use the existing seven-day retention policy. Storage errors fail execution rather than silently discarding output. This preserves observed process bytes, not data a killed process never flushed; interrupted foreground tool settlement can leave a retained log without a settled tool reference.

`bash.run_in_background` reuses the process-local BackgroundJob service. One `bash_job` tool provides get/wait/cancel with Session/Location ownership checks and the existing Bash permission policy. Waits default to thirty seconds and are limited to sixty seconds; the Bash execution timeout still applies. Launch and terminal results use existing durable shell events. Completion reaches Session history and event subscribers; the model can collect it with wait or on its next turn. It does not synthesize user input or start an unsolicited provider turn. Session stop/deletion and Location disposal cancel owned jobs. Cancellation waits for process cleanup before waking waiters. Same-call retries adopt the recorded job without relaunching or creating a misleading empty log; an unfinished record without a live owner is reported unavailable after restart.

Workspace create/remove operations are serialized by ID in the local service. Creation failure retains the record with an error status; retrying a compatible existing ID observes it without reprovisioning. Adapter cleanup must succeed before deleting Session history or the Workspace record. Failed cleanup preserves both so the user can inspect and retry. The built-in worktree adapter now waits for checkout/bootstrap and propagates failure instead of reporting a merely allocated directory as successfully created. The legacy worktree create API retains asynchronous startup by default.

## Retained and remaining

- Keep provider-neutral Session admission, execution coordination, tool settlement, and compaction. Keep existing MCP connection locks/client identity checks and WorkGraph Worker fencing/outbox behavior.
- Background process ownership cannot survive a process restart; no automatic command replay, remote job API, or idle-model continuation is added.
- Workspace provisioning and external cleanup are not distributed transactions. Partial allocation is retained for explicit cleanup, not rolled back blindly. Plugin-specific readiness, cross-process lifecycle fencing, and durable provisioning-status recovery remain outside this local pass.
- Semantic stale authorization under new steering remains deferred; current revalidation covers configured deny changes and missing Sessions.
- Shell configuration and transport policy are not unified with remote Workspace adapters by this patch. The shared constructor is a local execution primitive.
- Five-second polling currently belongs to each active subscription. Consolidate per-aggregate polling only if measured subscriber load warrants it.

## Verification

Core type checking passed. Focused existing and added regression coverage: 104 tests passed across Session creation/shell, events, AppProcess, and Bash. New coverage includes conflicting shell retries, Session stop settling explicit shell execution, and another EventV2 instance writing without sharing local wake notifications. The idle cross-instance observer case was also rerun after allowing the reader to reach its wait and passed after approximately five seconds.

Product acceptance, long-running workloads, real providers, cross-platform process cleanup, and an actual two-OS-process database scenario remain deferred. The cross-instance regression validates the independent-notification condition without claiming a complete distributed deployment test.

The subsequent approval/MCP pass passed 38 focused tests across permission, MCP, and Session creation. Two added regressions cover deny changes while approval is pending and isolation of pending approvals between distinct Location services. Existing MCP tests cover registration and execution, not cancellation at every registration boundary.

The pre-Zed follow-through passed Core and Zaovra package type checks, 93 focused Core tests, and three focused Workspace/worktree tests. New regressions exercise a real command producing more than one MiB and compare the entire retained log, background completion/ownership/Session stop, cancellation cleanup before waiter release, failed provisioning without duplicate allocation, cleanup failure preserving Session history, and awaited Git worktree creation. Product/real-provider acceptance remains deferred. Adapter promises have no cancellation contract, so create/remove retain the local lifecycle lock until the external call settles; cancellation may consequently wait for an adapter.
