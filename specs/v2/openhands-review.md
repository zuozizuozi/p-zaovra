# OpenHands SDK review

Reviewed 2026-09-13. Scope: durable state, events, workspace lifecycle, and separation of agent execution from runtime resources. This is a source-level comparison, not a runtime acceptance report.

## References

- [Workspace architecture](https://docs.openhands.dev/sdk/arch/workspace): execution/file-operation boundaries and resource setup/teardown.
- [Conversation persistence](https://docs.openhands.dev/sdk/guides/convo-persistence): restoring a conversation by identity, persisted state and event history.
- [Workspace implementation](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/workspace/base.py): workspace operation contracts and lifecycle hooks. This URL tracks upstream rather than a pinned release.

## Retained Zaovra mechanisms

| Concern | Existing implementation | Decision |
| --- | --- | --- |
| Durable identity and input | `session.ts`, `session/input.ts`: Session adoption and exact prompt retry reconciliation; admission precedes wake | Preserve; do not add a second conversation state store |
| Restore versus execute | `session/store.ts`, `session/execution.ts`: reads are separate from explicit resume/advisory wake | Preserve; reading persisted state must not replay provider work |
| Events and projections | `event.ts`: durable commit and projection, replay sequencing/ownership, post-commit observation | Preserve; no parallel JSON event log or event framework |
| Runtime placement | `session/execution/local.ts`: global Session-ID routing into Location-scoped runners | Preserve; resolve placement when the operation starts |
| Resource lifetime | `location-services.ts`: scoped cached services and idle expiry; coordinator owns running fibers | Preserve; no new Workspace manager or container abstraction without an implemented backend |
| Cancellation | `session/run-coordinator.ts`: process-local ownership and cleanup; observer cancellation does not own execution | Preserve; persisted history is not proof a process still exists |

## Implemented correction

Manual compaction previously read Session placement before waiting for the coordinator's exclusive slot. Its queued effect therefore captured the old Location. It now reads SessionStore inside the exclusive operation, checks that the Session still exists, and then acquires the current Location's services. Ordinary drains already resolve placement at execution start. This aligns both paths without changing public APIs or adding persistent execution identity.

The correction does not make arbitrary concurrent placement mutations safe. Session movement must still follow the existing placement/lifecycle contract; remote ownership and clustered execution remain separate designs.

## Deliberately not added

- No automatic provider restart when loading a persisted conversation.
- No duplicate runtime or conversation hierarchy beside Location, SessionStore, and SessionExecution.
- No container/cloud workspace provisioning without a concrete product requirement and lifecycle implementation.
- No arbitrary mutable agent-state bag where existing typed events and projections already represent the state.
- No change to the established distinction between durable observer isolation and fail-fast live-event listeners.

## Concrete follow-up for execution engineering

The subsequent Codex runtime pass moved `SessionV2.shell` onto the shared `AppProcess`/Bash shell-command construction, bounded capture, and cleanup path. Session interruption now also cancels its explicit shell invocations and waits for settlement. Explicit user shell execution and model-requested execution retain different authorization contracts. See `codex-runtime-review.md` for remaining runtime work.

Background subagent Sessions also do not imply a model-facing background shell lifecycle. Inspect existing BackgroundJob and process facilities before adding launch/observe/wait/cancel or completion delivery. Process restart must not turn an uncertain side effect into an automatic replay.

## Validation boundary

Core type checking and diff checks completed. Runtime tests remain deferred at the user's request. Later acceptance should cover a queued compaction observing changed placement, a deleted Session avoiding Location acquisition, interruption while waiting, unchanged normal compaction, and read-only restoration producing no provider/tool side effects. Existing event/coordinator regression suites should be included at final acceptance.
