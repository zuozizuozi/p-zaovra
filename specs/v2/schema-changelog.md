# V2 Schema Changelog

## 2026-08-07: Add Clustered Work Controllers and Managed Artifact Lifecycle

Affected schema:

- Add `ControllerID`, `ControllerRuntimeID`, Controller registry/status, durable Goal dispatch, and Artifact lifecycle contracts.
- Bind `work_lease` to the concrete Controller and Controller runtime in addition to Worker, process owner, and monotonic Goal fence.
- Add `work_controller` and `work_controller_dispatch` through migration `20260806222919_work_controller_cluster`.
- Add `work_artifact` and `work_artifact_owner` through migration `20260806223623_work_artifact_lifecycle`.

Change:

- Persist every Goal wake and interrupt as a coalesced, revisioned dispatch signal. Route signals to the active Goal lease owner and allow another online, non-draining Controller to claim only after the prior Goal and dispatch leases expire.
- Fence dispatch renewal and settlement with Controller ID, ControllerRuntimeID, revision, and monotonic dispatch fence. Settling an older revision cannot consume a newer signal recorded during execution.
- Recover one claimed Goal before continuing it. A durable completed remote Agent result advances to verification without a second provider call; an in-flight outcome without a durable result remains unknown and requires explicit resolution.
- Register content-addressed Work Artifacts with access timestamps and explicit owner references. Expose inventory and dry-run collection, and delete only unreferenced, retention-eligible content behind an immediate database transaction.
- Expose Controller pool, durable dispatch, and Artifact lifecycle state through HTTP, generated clients, and the WorkGraph IDE control plane.

Compatibility:

- Historical Goal leases keep nullable Controller identity and remain fenced by their existing Worker/owner/fence until expiry. New claims always write both Controller identifiers.
- Existing Artifact files remain readable through their durable references; lifecycle collection only considers Artifacts registered after this migration and therefore cannot accidentally sweep unknown legacy files.
- Controllers must share one strongly consistent database. SQLite/WAL supports same-host multi-process controllers; cross-host production deployment requires a database backend with equivalent transactional compare-and-set semantics and is not implemented by copying a SQLite file.
- Provider/tool work with unknown side effects is still never replayed automatically.

## 2026-08-07: Add Remote Worker Backpressure, Runtime Fencing, and Result Recovery

Affected schema:

- Add `WorkerRuntimeID`, Worker capacity, `cancelling` Job state, runtime-bound Job assignments, cancellation notices, and poll settlement acknowledgements.
- Bind Job heartbeat, log, Artifact, and completion payloads to the concrete Worker runtime in addition to Worker ID and monotonic fence.
- Add the local `work_worker_job_outbox` table plus Worker/runtime/cancellation lease columns through migration `20260806211353_work_worker_runtime`.

Change:

- Claim at most the Worker's declared 1–32 concurrent slots after counting all active leases; keep excess Jobs queued while long Agent Fibers execute independently of polling.
- Reject a second runtime while the current runtime heartbeat remains live, and fence all late writes from the wrong runtime even when it possesses the same Worker credential.
- Persist cancellation requests as `cancelling`, deliver them through Worker poll, interrupt the owning Fiber, and require an explicit interrupted result before cancellation can settle.
- Retry transient controller connectivity within the active lease instead of terminating the local Agent on the first network error.
- Store completed Worker output and pending Artifacts in a durable local outbox before remote upload. Rebind only `result_ready` records; an `executing` record remains unsafe and is never replayed automatically.
- Keep an unknown Job in a bounded recovery grace window so a restarted Worker can submit a durable result without racing the controller's unknown projection.

Compatibility:

- Existing Workers migrate with capacity 1 and no active runtime identity. A new authenticated poll establishes the runtime fence.
- Existing queued/leased/completed Job rows remain readable; runtime identity and cancellation metadata are nullable for historical records.
- Public Worker poll and Job mutation payloads changed and generated Promise, Effect, and legacy JavaScript clients were regenerated.
- This change hardens one controller with many Workers. It does not implement multi-controller consensus, queue partitioning, or automatic replay of in-flight provider/tool calls.

## 2026-08-07: Add Fenced Remote Job Logs and Artifacts

Affected schema:

- Add `WorkerGitDiffCapture`, ordered Job log, Job artifact, Job detail, and verified artifact-content contracts.
- Extend remote command operations/results with a frozen Git revision, bounded patch capture, content-addressed Artifact references, and explicit capture failures.
- Add durable `work_worker_job_log` and `work_worker_job_artifact` operational tables through migration `20260806193759_work_remote_artifacts`.
- Extend `WorkDetail` with remote Job summaries and add Worker log/artifact upload plus authenticated Job/artifact inspection endpoints.

Change:

- Accept Job logs only under an active Worker/job fence and a strict contiguous sequence. Exact retries reconcile, while out-of-order, conflicting, stale, oversized, or over-budget entries fail.
- Capture a remote Git patch only when the Worker has the exact controller-frozen HEAD and a clean workspace. Include untracked files through temporary intent-to-add state and restore the index before returning the patch.
- Recompute Artifact UTF-8 size and SHA-256 on the controller, store it through the existing content-addressed Work Artifact service, and bind its metadata to the owning Job, Worker, and fence.
- Reject completion results that forge, omit, duplicate, or reference unregistered Artifacts. Expose Job status, last log, Artifact metadata, and verified Artifact content to SDK and IDE consumers.
- Request Git patch capture from the real remote verifier path when a command criterion requires `diff` or `artifact` evidence; ordinary command/test and file verification retain their existing behavior.

Compatibility:

- No durable Work event version changes. Existing Worker Jobs acquire empty log and Artifact collections, and existing command operations remain valid because capture metadata is optional.
- Artifact upload is JSON/UTF-8 and limited to 4 MiB per patch in this slice. Streaming binary transport and remote Artifact garbage collection remain future production hardening.
- The full provider/tool Agent Attempt still executes on the controller. This change completes the fenced output transport required before moving that loop to a remote Worker; it does not claim clustered controller ownership.

## 2026-08-07: Add Fenced Remote Worker Jobs

Affected schema:

- Add explicit `shared` and `remote` Worker execution modes plus cross-device controller-root to Worker-root Location mappings.
- Add `WorkerJobID`, operation/result/assignment/status contracts and the durable `work_worker_job` operational table.
- Extend authenticated Worker polling with remote Job assignments and add fenced heartbeat/completion endpoints.

Change:

- Keep Goal, Attempt, Evidence, Evaluation, placement, and Goal lease truth on the controller while dispatching command/file verifiers to a remote Worker without sharing SQLite.
- Give every remote Job an independent lease and monotonic fence. An expired leased Job becomes `unknown` and is never silently replayed; exact completion retries reconcile while conflicting or stale results fail.
- Translate controller Locations only through enrolled mappings, reject paths outside the mapped Worker root, cap command output and completion payloads, and require HTTPS for non-loopback remote controllers.
- Let the controller proxy Goal orchestration only for `remote` placements; an independently running `shared` Worker remains the sole eligible runtime for its placement.

Compatibility:

- Existing Worker rows migrate to `shared` with no Location mappings, preserving the Phase 7B shared SQLite behavior.
- Newly enrolled Workers default to `remote`; remote enrollment requires an explicit Location mapping in the CLI and IDE.
- This slice remotely executes deterministic command/file verification only. Provider/tool execution, Artifact/patch transfer, remote logs, and clustered controller ownership remain follow-up work.

## 2026-08-06: Add Durable Worker Placement and Worker-Fenced Leases

- Add `WorkerID`, public Worker capability/status/lease/placement contracts, and durable `work.goal.placement-assigned.1` and `work.goal.placement-released.1` events.
- Add the `work_worker` heartbeat registry, persist `work_goal.worker_id`, and bind `work_lease` to Worker ID in addition to process owner and monotonic fence.
- Reject placement on offline, draining, incapable, or workspace-incompatible Workers, and reject reassignment while an active lease exists.
- Extend the Work HTTP API and generated Promise, Effect, and legacy JavaScript clients with Worker heartbeat/drain, Worker listing, placement assignment/release, and placement detail.
- Preserve existing local Goals and leases through nullable Goal placement and a `worker_local` migration default. This release establishes a safe scheduling boundary; authenticated remote dispatch, Artifact transfer, and cross-device Location mapping remain a later protocol change.

## 2026-08-06: Add Durable Work Handoffs and Verified Project Memory

- Add `HandoffID`, structured `HandoffOutput`/`HandoffInfo`, and the durable `work.task.handoff-recorded.1` event.
- Add the `work_handoff` projection with one immutable Handoff per completed execution Task, bound to a successful Attempt, verified Evidence IDs, and a content digest.
- Extend `WorkDetail` in the HTTP API and generated Promise, Effect, and legacy JavaScript clients with `handoffs`.
- Stop building dependency prompts from predecessor Session chat. Downstream Executors, Reviewers, and Architects consume durable Handoffs; legacy successful outputs are deterministically materialized at the safe scheduling boundary.
- Register verified project Handoffs as a refreshable Location-scoped System Context source. Existing databases migrate forward without rewriting historical events; completed legacy Tasks acquire Handoffs when their Goal next drains.

## 2026-06-26: Add Finite Session History

- Add `GET /api/session/:sessionID/history` and generated Promise, Effect, and legacy JavaScript client methods.
- Page public durable Session events after an optional exclusive aggregate sequence, with an explicit `hasMore` exhaustion signal.
- Keep aggregate gaps legal, cap pages at 100 events, and preserve the existing durable replay-and-tail `sessions.events()` stream unchanged.
- Add no migration or durable-event version; this is a finite read API over the existing event manifest.

## 2026-06-22: Simplify Session Input Promotion

- Keep `session.next.prompt.admitted.1` as the durable, client-visible record of pending Session input.
- Replace `session.next.prompt.promoted.1` with the existing `session.next.prompted.1` event when input becomes model-visible.
- Preserve the prompt endpoint, admission receipt, idempotency, steer/queue ordering, and atomic user-message projection.
- Reset experimental V2 events, projections, inputs, Context Epochs, and synchronized workspace state while preserving canonical V1 `session`, `message`, and `part` rows.

## 2026-06-22: Reset Unpublished Compaction Event

- Replace the unpublished `session.next.compaction.ended.1` payload with the current checkpoint payload and remove its legacy decoder.
- Reset experimental events, sequences, Session inputs, projected Session messages, Context Epochs, synchronized workspace rows, and Session workspace links.
- Preserve canonical V1 `session`, `message`, and `part` rows.

## 2026-06-22: Make Session Interruption Process-Local

- Remove the unprojected `session.next.interrupt.requested.1` event from the experimental durable Session event union and generated SDK.
- No canonical V1 data requires migration; experimental V2 event history containing the retired event is disposable.

## 2026-06-05: Execute Automatic Session Compaction

- Trigger automatic compaction before provider turns using the complete estimated request and absolute model-aware headroom.
- Preserve the existing structured summary contract and update prior summaries with newly compacted history.
- Store token-bounded recent history as plain serialized text inside the checkpoint instead of replaying provider-native messages.
- Keep compaction starts durable and progress deltas live-only; activate history cutover only from a durable completed summary.
- Store the completed event with the current checkpoint payload containing stable message identity, reason, summary, and recent context.
- Reload the replacement Context Epoch and continue the original pending turn after compaction.
- Preserve full durable history; compaction changes only the active model representation.
- Defer provider-overflow recovery, explicit manual compaction, and deterministic old tool-result pruning.

Record V2 database, durable-event, projected-message, HTTP, and generated SDK schema changes here. Each entry states why the contract changed and whether consumers or stored data need compatibility handling. Commit messages for schema-affecting changes should include the same summary.

This document covers meaningful contract changes introduced on the `feat/zaovra-embedded-api` branch since its divergence from `origin/dev`. Mechanical file moves and internal refactors are omitted unless they changed stored data, replay behavior, public HTTP or SDK shapes, or model-facing tool contracts.

## 2026-06-04 Event-Sourced Session Input Cutover

Affected schema:

- `session_input`, `session_message`, `event`, `event_sequence`, and disposable workspace beta storage.
- New synchronized `session.next.prompt.admitted.1` and `session.next.prompt.promoted.1` events.
- Experimental `SessionV2.prompt(...)`, HTTP, and generated SDK admission receipt.

Change:

- Replace inbox-local admission sequence with event-sourced prompt admission and promotion sequences.
- Give projected Session messages stable `msg_*` resource IDs distinct from `evt_*` creator event IDs.
- Give every event that creates a projected transcript resource an explicit `msg_*` resource ID. Assistant steps propagate one `assistantMessageID` through assistant-owned events.
- Reset incompatible unreleased beta event history, derived Session projections, workspace rows, and Session workspace links.

Compatibility:

- The reset preserves canonical V1 `session`, `message`, and `part` rows.
- Existing synchronized workspaces are disposable beta state and are removed by the reset.
- Before starting the new build, discard adapter-managed external workspace resources created by unreleased builds. The SQL migration cannot remove external resources through runtime adapters, and rediscovering retained resources after startup can replay incompatible beta history.
- Exact prompt retries reconcile one stable `msg_*` identity when Session, prompt, and delivery mode match.

## Earlier Branch History

### Replayable Session Event Refinement And Cursor Stream

Affected schema:

- Existing synchronized `session.next.*` event family in `packages/core/src/session/event.ts`.
- Existing projected V2 Session-message union in `packages/core/src/session/message.ts`.
- New explicit durable-event union and internal replay cursor returned by `sessions.events({ sessionID, after? })`.

Change:

- Keep the existing Session lifecycle event family and projected-message union rather than introducing them in this branch.
- Stop synchronizing text deltas, reasoning deltas, and tool-input deltas; keep them explicitly ephemeral.
- Add an explicit durable-event union for replay-safe consumers.
- Add replay-and-tail aggregate cursors backed by durable Session-event sequence.
- Encode synchronized event payloads before writing JSON storage and decode them while replaying so schema transforms remain explicit at the durable boundary.

Reason:

- Embedded Session execution needs a reconnect-safe replay stream over the existing durable log and derived chronological read model.
- Fragment streams are useful to connected renderers but must not advance durable cursors or inflate synchronized storage.

Compatibility:

- The `session.next.*` lifecycle event family predates this branch; this branch refines its experimental V2 durability and replay contracts.
- Durable replay cursors are per-aggregate event sequences; ephemeral deltas are intentionally absent after reconnect.

### Durable Step Settlement Ownership

Affected schema:

- `session.next.step.ended` and `session.next.step.failed` synchronized event version `2`.

Change:

- Bind step settlement to an explicit assistant message ID.

Reason:

- Provider-local call identifiers can repeat across turns.

Compatibility:

- Step settlement uses synchronized event version `2` because the durable payload changed.

### Durable Session Input Inbox

Affected schema:

- New `session_input` table from `20260603141458_session_input_inbox.ts`.
- Updated pending-input index from `20260603160727_jittery_ezekiel_stane.ts`.
- New `SessionInput.Admitted` schema and `Prompted.delivery` field.
- Prompt-admission conflict behavior in `SessionV2.prompt(...)`.

Change:

- Persist admitted prompts before projection with an autoincrement inbox sequence, unique message ID, Session ID, encoded prompt, `steer` or `queue` delivery mode, optional promoted event sequence, and creation time.
- Index pending inputs by Session, promotion state, delivery mode, and admission sequence.

Reason:

- Prompt admission and model-visible promotion must be separate durable operations.
- Steering must promote at safe provider-turn boundaries while queued prompts remain pending in FIFO order until continuation would otherwise end.

Compatibility:

- Database migration creates the inbox table and replaces its first pending index with a delivery-aware index.
- Exact prompt retries are idempotent; reusing a message ID for different input fails.

### Durable Session Projection Order

Affected schema:

- `session_message.seq` from `20260603040000_session_message_projection_order.ts`.
- Session-message and event indexes from `20260603001617_session_message_projection_indexes.ts`, `20260603040000_session_message_projection_order.ts`, and `20260603160727_jittery_ezekiel_stane.ts`.

Change:

- Reset pre-launch Session-message projections and add `session_message.seq` for newly projected synchronized events.
- Add event aggregate-sequence and aggregate-type-sequence indexes.
- Add Session-message sequence, type-sequence, and compatibility timestamp indexes.

Reason:

- Projected history, replay, compaction lookup, and pagination must follow durable aggregate order rather than timestamps or caller-generated IDs.
- Runner and HTTP read paths need covering indexes for their concrete lookup shapes.

Compatibility:

- Pre-launch Session-message projections are disposable because historical versions could write them without durable creator events.
- The migration resets those projections rather than inventing chronology or blocking startup.
- The timestamp compatibility index remains for legacy or transitional query shapes.

### Structured Tool Registry And Canonical Output

Affected schema:

- Core-owned typed tool registry contract.
- Canonical tool output content and structured settlement schemas.
- Canonical tagged tool file sources in `@zaovra-ai/llm`.
- Durable tool called, progress, success, and failure events and projected assistant-tool states.

Change:

- Validate model input against each registered tool's parameter schema.
- Validate handler success against each tool's success schema before optional pure model-output lowering.
- Generate optional tool-definition output JSON Schema from typed success schemas.
- Persist canonical structured output and content for running, completed, and failed tools.
- Represent tool files explicitly as inline data, remote URL, or managed file URI sources rather than one ambiguous URI string.

Reason:

- Embedded tool execution needs one typed boundary between provider calls, local side effects, durable settlement, and replay.

Compatibility:

- These are additive experimental V2 runtime contracts.
- Tool results are durably settled before provider continuation.
- Legacy text, JSON, and inline-media results remain convertible; unresolved URL and file sources must be materialized or explicitly rejected before provider lowering.

### Managed Tool-Output Files

Affected schema:

- New optional managed `outputPath` and `outputPaths` fields on tool results and completed Session tool state.
- Absolute managed output paths accepted by ordinary `read` and `grep` inputs.

Change:

- Spill oversized model-facing tool text into globally unique files under Zaovra's shared tool-output directory.
- Include the absolute file path in the bounded preview so ordinary `read`, `grep`, and `bash` operations can inspect it.

Reason:

- Tool results need bounded model context without discarding the full output.
- Filesystem resolution admits only direct generated `tool_*` files from the managed directory, while existing permissions whitelist that directory.

Compatibility:

- Managed output is retained for a bounded period and exposed as a normal host filesystem path.

### Location-Scoped Filesystem Read And Search Contracts

Affected schema:

- Core filesystem read, directory-list, root-resolution, and named-reference inputs.
- `LocationSearch.FilesInput`, `LocationSearch.GrepInput`, and bounded result schemas.
- `read`, `glob`, and `grep` tool parameters and success payloads.

Change:

- Add bounded file reads, paged directory listings, bounded glob results, and bounded grep matches with line previews.
- Allow named project references for read-oriented operations.
- Resolve and pin canonical approved search roots before traversal.
- Exclude hidden path segments from broad V2 glob and grep discovery.

Reason:

- Embedded tools need deterministic bounds and a shared path-containment authority.
- Broad search should not disclose hidden files implicitly.

Compatibility:

- These are additive V2 tool contracts.
- Hidden-file discovery is intentionally narrower than an unconditional ripgrep `--hidden` traversal.

### Location Workspace Identity

Affected schema:

- `Location.Ref.workspaceID`.
- V2 Location HTTP middleware routing.

Change:

- Brand optional Location workspace identity as `WorkspaceV2.ID` instead of an untyped string.
- Preserve nested `location[workspace]` and workspace-header routing inputs while decoding them into the branded identity.

Reason:

- Location-scoped services and embedded routing need one typed workspace identity boundary.

Compatibility:

- Existing workspace strings remain accepted when they satisfy the workspace ID schema.
- Generated OpenAPI reflects the workspace prefix constraint.

### Structured Mutation Authority And File Leaves

Affected schema:

- New `LocationMutation.ResolveInput`, planned target, external-directory authorization, and typed path errors.
- New `write` and exact `edit` tool schemas.
- New internal file-mutation commit service.

Change:

- Resolve relative mutation paths within the active Location.
- Accept absolute internal paths and require explicit `external_directory` approval before leaf approval for external absolute paths.
- Keep named references read-oriented and reject them for mutation.
- Revalidate path authority immediately before write mechanics.

Reason:

- Mutation tools need explicit capability escalation and symlink/path-swap checks without pretending path APIs provide a syscall-level sandbox.

Compatibility:

- These are additive V2 mutation contracts.
- Richer V1 fuzzy edit behavior remains intentionally deferred.

### V2 Permission Requests And Saved Rules

Affected schema:

- `PermissionV2.Request`, `AssertInput`, `ReplyInput`, source metadata, tagged errors, and lifecycle events.
- V2 permission list, reply, and saved-rule HTTP routes and generated SDK schemas.

Change:

- Add Location-scoped pending permission requests with `once`, `always`, and `reject` replies.
- Attach optional originating tool message and call IDs.
- Preserve authored ordered rules and saved approvals as separate inputs to evaluation.
- Establish action and resource conventions for `read`, `glob`, `grep`, `edit`, `external_directory`, `bash`, `todowrite`, and `webfetch` approvals.

Reason:

- Embedded tool calls need a Core-owned authorization boundary that can suspend and resume through HTTP.

Compatibility:

- These are additive experimental V2 contracts.
- Policy authors should account for canonical resource forms; originating tool source metadata remains optional until every registry call carries its durable assistant owner.

### Initial Core V2 Built-In Tool Schemas

Affected schema:

- `read`, `glob`, `grep`, `write`, exact `edit`, `bash`, and `websearch` model-facing tool contracts.

Change:

- Add Core-owned Location-scoped built-ins with explicit parameter and success schemas.
- Bound bash output and timeout input, search result counts and previews, read sizes, directory pages, and websearch result/context controls.

Reason:

- Embedded runner launch requires a minimal typed tool set without importing legacy application orchestration.

Compatibility:

- These are additive V2 built-ins.
- Richer launch-follow-up leaves such as `apply_patch`, skill loading, task dispatch, and LSP remain separate slices.

### Bash Advisory Warnings

Affected schema:

- Optional `warnings` in the `bash` tool success payload.

Change:

- Return advisory warning strings when best-effort command-argument scanning detects external absolute paths; keep structured external `workdir` approval enforced.

Reason:

- A shell subprocess has host-user filesystem, process, and network authority. Token scanning cannot honestly provide containment.

Compatibility:

- Consumers rendering bash success should tolerate optional warning strings.

### V2 Session HTTP And Generated SDK Contracts

Affected schema:

- V2 Session list, prompt, context, message-list, compact, and wait HTTP routes.
- V2 Location query routing fields.
- Generated OpenAPI and JavaScript SDK schemas.

Change:

- Expose embedded Session creation and read-side behavior over the experimental HTTP API.
- Accept optional prompt admission `id`, `delivery`, and `resume` fields so callers can request idempotency, steering or queue semantics, and durable admission without immediate execution.
- Keep message cursors opaque and preserve configured Location routing through both legacy flat and nested `location[...]` query parameters in the V2 SDK client.

Reason:

- Remote and embedded consumers need one generated contract while Location middleware remains compatible with current server routing.

Compatibility:

- These are experimental V2 routes.
- Prompt admission now returns the admitted user-shaped message and may return a conflict error when one message ID is reused for different input.
- SDK Location GET rewriting preserves existing flat query behavior and adds nested compatibility parameters.

## 2026-06-03: Durable Session Message Pagination

Affected schema:

- Internal `SessionV2.messages()` cursor input.
- Opaque cursor payload returned by `GET /api/session/:sessionID/message`.

Change:

- Remove wall-clock `time` from the message cursor payload.
- Resolve the opaque cursor's projected message `id` to its stored `session_message.seq`.
- Apply page boundaries and ordering with durable per-session `seq` rather than `time_created` plus `id`.

Reason:

- Projected V2 message chronology is defined by synchronized Session-event order.
- Wall-clock timestamps may collide or move backwards, so they are not safe pagination boundaries.
- The list endpoint must agree with replay and context loading, which already order by durable sequence.

Compatibility:

- No database migration is required. `session_message.seq` and its session-scoped index already exist.
- The HTTP cursor remains opaque and existing cursors remain usable because they already carry the projected message `id`; older extra `time` data is ignored while decoding.
- No OpenAPI or generated SDK schema changes are required for this pagination correction.

## 2026-06-03: Public Provider And Model Catalog DTOs

Affected schema:

- Responses from `GET /api/provider`, `GET /api/provider/:providerID`, and `GET /api/model`.
- Generated `ProviderV2PublicInfo` and `ModelV2PublicInfo` SDK schemas.

Change:

- Replace internal catalog response schemas with explicit public DTOs.
- Remove provider request headers and bodies, API settings, custom enablement data, model request overrides, and variant request overrides from public responses.

Reason:

- Internal catalog records may contain credentials or provider-specific request material and must not cross the public HTTP serialization boundary.

Compatibility:

- Public V2 catalog responses intentionally expose fewer fields.
- Internal provider and model schemas remain available to the runtime.

## 2026-06-03: Durable Reasoning And Hosted Tool Replay Metadata

Affected schema:

- Durable `session.next.reasoning.started` and `session.next.reasoning.ended` events.
- Durable `session.next.tool.success` and `session.next.tool.failed` events.
- Projected assistant reasoning and settled tool message state.

Change:

- Add optional reasoning `providerMetadata`.
- Add optional durable tool `result` and project it into settled tool message state.
- Preserve projected tool-call metadata separately from optional settlement-result metadata.
- Replay provider-native reasoning and tool metadata only when the historical assistant model matches the selected continuation model.

Reason:

- Provider continuation requires signed or encrypted reasoning metadata on later turns.
- Provider-executed hosted tool results must survive projection so replay can keep hosted calls and results inline in assistant content.
- Recovery settlement must not erase provider-native call metadata needed to reconstruct a valid continuation request.

Compatibility:

- Added durable-event fields are optional so previously recorded experimental events remain decodable.
- Projected settled tool state gains model-facing result data when available.
- Projected assistant tools gain optional result-side provider metadata; the existing metadata slot remains the backward-compatible call-side slot.
- OpenAI Responses lowers reconstructed provider-executed hosted results to stored item references instead of rejecting assistant history.
- Bedrock Converse signatures, Gemini `thoughtSignature`, and OpenAI-compatible Chat `reasoning_content` now round-trip through canonical continuation parts.

## 2026-06-03: Projected Assistant Ownership And Full-Value Parts

Affected schema:

- Projected assistant text parts.
- Durable text and tool lifecycle boundaries.
- Projected assistant tool ownership.

Change:

- Preserve stable IDs on projected assistant text parts.
- Route durable tool projection updates through explicit owning assistant message IDs rather than provider-local call IDs alone.
- Replay full-value text and tool-input end checkpoints while keeping fragment deltas ephemeral.

Reason:

- Provider-local tool call IDs may repeat across turns.
- Durable projection reconstruction must not depend on ephemeral fragments that disappear after reconnect.

Compatibility:

- Earlier experimental projected assistant rows without stable text IDs are not assumed replay-compatible.
- Current V2 histories reconstruct from durable full-value checkpoints.

## 2026-06-03: Location-Scoped V2 Questions

Affected schema:

- New `QuestionV2.*` domain schemas.
- New `question.v2.asked`, `question.v2.replied`, and `question.v2.rejected` events.
- New question list, reply, and reject HTTP routes and generated SDK schemas.

Change:

- Add schemas for pending requests, question options, ordered answers, and tool ownership metadata.
- Add `GET /api/question/request`.
- Add `POST /api/session/:sessionID/question/request/:requestID/reply`.
- Add `POST /api/session/:sessionID/question/request/:requestID/reject`.

Reason:

- Embedded V2 tool execution needs a Location-owned pending-question service whose suspended replies can be settled through HTTP.

Compatibility:

- These are additive experimental V2 contracts.
- No database migration is required because pending questions are intentionally in-memory Location state.

## 2026-06-03: Core-Owned Todo Update Event

Affected schema:

- Core-owned `SessionTodo.Info`.
- Global `todo.updated` event registration.

Change:

- Register the todo update event from Core session-todo ownership and expose the existing todo item shape to the Core V2 tool.

Reason:

- Embedded V2 `todowrite` execution needs Core-owned persistence and update publication without importing legacy application orchestration.

Compatibility:

- The todo table and public todo update event shape are preserved.
- No database migration is required.

## 2026-06-03: Added Core V2 Tool Schemas

Affected schema:

- New `todowrite` tool parameters and success payload.
- New `question` tool parameters and success payload.
- New `webfetch` tool parameters and success payload.

Change:

- Add a todo replacement-list tool using `SessionTodo.Info` items.
- Add a question tool using ordered `QuestionV2.Prompt` values and ordered answer arrays.
- Add an HTTP(S) fetch tool with explicit `text`, `markdown`, and `html` formats, bounded timeout input, and optional managed output resource metadata.

Reason:

- Embedded V2 execution needs Core-owned built-ins rather than imports from legacy application orchestration.
- Explicit schemas keep model-facing definitions, runtime validation, and durable tool settlement aligned.

Compatibility:

- These are additive Location-scoped V2 built-ins.
- No database migration or public HTTP API migration is required.

## 2026-06-03: Conditional File-Mutation Stale Error

Affected schema:

- New internal `FileMutation.StaleContentError` tagged error.

Change:

- Add a typed error carrying the mutation target path when an approved exact edit no longer matches the bytes at commit time.

Reason:

- V2 exact edits must fail rather than stale-clobber a concurrent cooperating write after permission approval.

Compatibility:

- This is an additive internal error contract.
- No database, HTTP, or generated SDK schema changes are required.

## 2026-06-03: Provider Stream Watchdog Policy Deferred

Affected schema:

- No database, durable-event, HTTP, or generated SDK schema changes.
- Internal Session-runner provider-stream policy.

Change:

- Do not impose a universal provider-stream inactivity or absolute timeout.
- Remove the internal timeout error and hardcoded watchdog service.
- Defer provider timeout, retry, watchdog, durable failure-reporting, and drain-chain-release policy to a configurable design slice.

Reason:

- V1 had no universal processor inactivity watchdog.
- Providers and autonomous workloads have different runtime characteristics, so one hardcoded default is premature.

Compatibility:

- No migration or generated artifact regeneration is required.
- Embedded runner callers do not receive a runner-defined provider-stream timeout error.

## 2026-06-03: Keyed Coalescing Durable Tail Signals

Affected schema:

- No database, durable-event, HTTP, or generated SDK schema changes.
- Internal durable aggregate-tail wake delivery only.

Change:

- Replace the process-global unbounded aggregate-ID PubSub with one sliding-capacity-1 dirty signal per active tail and aggregate.
- Subscribe and register the signal before historical SQLite replay, then remove it when the tail closes.
- Re-query durable rows after each dirty edge and advance only by persisted aggregate sequence.

Reason:

- Wake notifications are advisory edges, not durable event payloads.
- Slow consumers should not retain an unbounded number of redundant wake IDs when one SQLite query can recover every committed row after their cursor.
- Per-tail signaling preserves independent cursors for multiple consumers of the same aggregate.

Compatibility:

- No migration, synchronized event version, OpenAPI, or SDK regeneration is required.
- `sessions.events({ sessionID, after? })` remains a replay-and-tail stream of every durable event in aggregate sequence order.

## 2026-06-03: Sequential V2 Apply Patch Tool

Affected schema:

- New Core-owned `apply_patch` model-facing tool parameters and success payload.
- New Core-owned pure patch hunk representation for add, update, and delete operations.

Change:

- Accept `{ patchText: string }` using the `*** Begin Patch` envelope.
- Return ordered applied-operation records carrying `type`, canonical `target`, and permission-facing `resource`.
- Resolve and approve every target before reading approved update/delete contents.
- Preflight update/delete correctness before committing operations sequentially.
- Report already-applied resources explicitly when a later commit fails.

Reason:

- Embedded V2 agents need reviewable multi-file edits without importing legacy application orchestration into Core.
- Sequential semantics are small and honest: they avoid claiming rollback or transactionality that path-based filesystem commits do not provide.

Compatibility:

- This is an additive model-facing V2 tool contract.
- Moves and atomic rollback are deliberately unsupported in the first slice and remain visible follow-ups.
- No database migration, durable-event version, public HTTP, OpenAPI, or generated SDK change is required.

## 2026-06-03: Embedded Local-Tool Recovery Alignment

Affected schema:

- No database, durable-event, HTTP, or generated SDK schema changes.
- Internal runner recovery and permission evaluation behavior only.

Change:

- Evaluate permissions through the default `build` agent when a Session omits an explicit agent, matching provider-turn execution.
- Before assembling a provider request, durably fail local tools still projected as `running` from a previous process with the existing `session.next.tool.failed` shape and `Tool execution interrupted` message.

Reason:

- Agent-less embedded Sessions previously executed as `build` while evaluating an empty permission ruleset, so the first local tool could wait forever for an approval surface the local Discord proof did not expose.
- A process lost while a local tool was running previously left a dangling tool call that made later provider continuation invalid. Recovery must settle the durable projection without replaying an abandoned side effect.

Compatibility:

- No migration, synchronized event version, OpenAPI, or SDK regeneration is required.
- Existing experimental Session databases recover dangling local-tool projections on the next provider attempt.

## 2026-06-03: V2 Skill Tool

Affected schema:

- New Core-owned `skill` model-facing tool parameters and success payload.
- Existing upstream `SkillV2` service remains the single Location-scoped skill registry.

Change:

- Accept `{ name: string }` for one skill selected from the upstream-discovered Location skill list.
- Assert `skill` permission for the selected name.
- Return V1-shaped `<skill_content name="...">` model output with the skill base directory and a bounded sampled supporting-file list.

Compatibility:

- This is an additive model-facing V2 tool contract.
- No database migration, durable-event version, public HTTP, OpenAPI, or generated SDK change is required.

## 2026-06-03: Pre-PR V2 Safety Review

Affected schema:

- V2 OpenAPI request bodies preserve requiredness instead of inheriting legacy optional-body normalization.
- Existing durable tool-failure and replay-owner schemas are reused without version changes.

Change:

- Fence replay envelopes whose aggregate ID differs from the decoded synchronized payload and persist owner claims when replay first adopts an existing unowned aggregate.
- Settle abandoned local and provider-executed tools durably before continuation; hosted failures preserve inline provider-executed replay.
- Give `apply_patch` add hunks create-only semantics, make sequential commits uninterruptible after preflight, and reject malformed patch grammar eagerly.
- Wait for initial plugin boot before materializing the `skill` built-in, discover conventional config-root skill directories, and resolve current skills again during execution.
- Sanitize provider and model public API URLs by stripping credentials, queries, and fragments.
- Keep V1-like `webfetch` network semantics: approve the requested HTTP(S) URL, allow ordinary hostnames, and delegate redirects to the HTTP transport.
- Keep V2 request bodies required in generated OpenAPI and SDK types.

Compatibility:

- No database migration is required.
- Pre-launch `session.next.*` databases remain disposable experimental state rather than compatibility targets; reset experimental V2 data when upgrading across incompatible event-schema iterations.
- V1 returns fetched images as attachments. The first Core V2 typed settlement remains text-only, so V2 continues to reject fetched images and other non-text files until attachment settlement is designed explicitly.

## 2026-06-03: Defer V2 Bash Background Execution

Affected schema:

- Core V2 model-facing `bash` tool parameters and success payload.

Change:

- Remove the optional `background` bash parameter and process-local background settlement shape from the shipped tool.
- Retain the internal `BackgroundJob` prototype for a later integration slice.

Reason:

- The model has no registered observation or cancellation tool for background bash jobs, and process-local status is not a sufficient remote contract.

Compatibility:

- Foreground V2 bash execution is unchanged.
- Reintroduce background bash only with durable status observation, completion delivery, and explicit cancellation semantics.

## 2026-06-18: Remove Bash Description Input

Affected schema:

- V1 and Core V2 model-facing `bash` tool parameters.

Change:

- Remove the V1 required and V2 optional `description` parameter.
- Derive shell presentation from the command or a generic shell label instead of model-authored description metadata.

Compatibility:

- Existing persisted tool calls may still contain `description`, but new tool definitions no longer expose or require it.
- Shell command execution behavior is unchanged.

## 2026-06-04: Add Durable Session Context Snapshots

Affected schema:

- Add `session_context_epoch` for one active immutable baseline string, structured JSON snapshot, and baseline sequence per Session.

Change:

- Lazily initialize one durable Context Epoch snapshot at the first safe provider-turn boundary.
- Lower its exact baseline string through `LLMRequest.system` for every provider turn in the epoch.
- Reuse the stored baseline verbatim after restart or producer changes instead of resampling privileged initial context.
- Compare later observations against an overwriteable codec-encoded structured snapshot rather than rendered-text hashes.
- Expose admitted chronological context as first-class `system` Session messages while keeping the active baseline in bounded context state.

Compatibility:

- The unpublished Context Epoch schema is consolidated into one database migration; baseline and structured snapshots are operational state rather than synchronized event history.
- Existing experimental V2 Session databases remain disposable across incompatible pre-launch event-schema changes.
- Chronological context updates, replacement epochs after compaction or model switches, project instructions, skills guidance, and plugin transforms remain follow-up slices.

## 2026-06-04: Admit Chronological Session Context Updates

Affected schema:

- Add synchronized `session.next.context.updated.1` Session events containing a durable System-message ID and only exact combined model-visible text.
- Add `session_context_epoch.revision` for transactional structured-snapshot advancement.
- Add the first-class `system` Session message projection for chronological context updates.

Change:

- Reconcile Location-scoped Context Sources at each safe provider-turn boundary using one coherent observation.
- Keep the stored baseline immutable while admitting changed source renderings as chronological `Message.system(...)` history.
- Advance the overwriteable structured snapshot atomically with the rendered System-message event.
- Emit the previously stored model-meaningful removal rendering when a source is removed.
- Reject chronological system updates that would split a local tool call from its result across provider protocols; use wrapped user fallback when Anthropic native system-update placement is unsupported.

Compatibility:

- The synchronized event log retains only text actually shown to the model, not internal structured snapshots.
- Existing experimental V2 Session databases remain disposable across incompatible pre-launch event-schema changes.
- Replacement epochs after compaction or model switches, skills guidance, and plugin-defined context remain follow-up slices.

## 2026-06-04: Replace Session Context Epochs Lazily

Affected schema:

- Add nullable `session_context_epoch.replacement_seq` for idempotent lazy replacement requests.

Change:

- Mark the active Context Epoch for replacement after a model switch or completed compaction projection.
- Persist the triggering aggregate sequence so same-target replay cannot reopen an already-settled replacement.
- Render and overwrite the fresh immutable baseline and structured snapshot lazily at the next safe provider-turn boundary.
- Exclude chronological System messages from earlier epochs when assembling active provider history.

Compatibility:

- Baseline replacement is bounded operational state and does not add permanent synchronized events.
- Existing experimental V2 Session databases remain disposable across incompatible pre-launch event-schema changes.
- Compaction execution, skills guidance, and plugin-defined context remain follow-up slices.

## 2026-06-05: Register Ambient System Context Producers

Affected schema:

- No database schema changes.

Change:

- Replace the Session-specific context loader with a Location-scoped registry of stable-keyed scoped context producers.
- Register environment/date and ambient instruction producers independently, then evaluate producers concurrently in stable contribution-key order.
- Directly discover and read global plus upward project `AGENTS.md` files at each safe provider-turn boundary.
- Preserve admitted instructions across transient scan/read failures and block first-epoch initialization while any context source is unavailable.
- Retry Context Epoch preparation until stable after optimistic revision mismatches.
- Clear the active Context Epoch when a Session moves so the destination initializes a complete baseline before promoting more input.
- Fence Context Epoch initialization against the authoritative Session Location so a concurrent old-Location runner cannot recreate stale privileged context after a move.
- Canonicalize ambient instruction traversal boundaries, honor `ZAOVRA_DISABLE_PROJECT_CONFIG`, and make non-empty aggregate updates explicitly supersede previously loaded instructions.

Compatibility:

- Watcher-backed per-file `Refreshable` instruction observations, configured sources, nested discovery, and plugin-defined context remain follow-up slices.

## 2026-06-05: Admit Selected-Agent Skill Guidance

Affected schema:

- Add `session_context_epoch.agent` so each durable baseline records its owning effective agent.
- No synchronized event, public HTTP API, or generated SDK schema changes.

Change:

- Compose selected-agent, permission-filtered available-skill guidance with Location-wide System Context before Context Epoch admission.
- Keep skill bodies behind the existing permission-checked `skill` tool and remove the unfiltered skill list from its Location-wide definition.
- Stop missing-skill errors from enumerating the unfiltered Location-wide skill catalog.
- Bind local tool authorization and pending permission requests to the provider turn's effective agent.
- Keep absolute skill locations out of available-skill guidance; expose body and location only through the permission-checked `skill` tool.
- Request Context Epoch replacement after an agent switch, dynamically re-observe the effective agent during retries, and fence first-epoch creation against the authoritative effective agent.
- Fence existing-epoch replacement against the authoritative effective agent and block cross-agent provider turns while replacement context is unavailable.
- Group the System Context algebra, registry, and built-ins under `system-context/`; keep source producers and Context Epoch persistence with their owning Skill, instruction, and Session modules; rename projected conversation selection to Session History.
- Add the canonical V1-to-V2 runtime-context parity checklist to `specs/v2/session.md`.

Compatibility:

- Existing Context Epoch rows backfill the default `build` agent and reconcile to another selected agent at the next safe provider-turn boundary.

## 2026-06-22: Simplify Session Context Rebaselining

Affected schema:

- Remove `session_context_epoch.agent`, `session_context_epoch.replacement_seq`, and `session_context_epoch.revision`.
- No synchronized event, public HTTP API, or generated SDK schema changes.

Change:

- Sample the effective agent and model once for each provider turn; selection changes apply to the next turn.
- Preserve the immutable baseline and admit ordinary System Context changes as chronological `ContextUpdated` messages.
- Rebuild the baseline directly after completed compaction instead of maintaining pending replacement state.
- Preserve the old baseline and its effective chronological updates while a post-compaction baseline cannot be rendered completely.
- Rely on the process-local Session execution lane instead of optimistic concurrency state between Context Epoch writers.

Compatibility:

- Existing Context Epoch rows migrate in place by dropping the obsolete selection and pending-replacement columns.
- Model and agent switches no longer discard earlier chronological System Context updates by forcing a new baseline.

## 2026-08-06: Add WorkGraph Role Contracts, Directed Handoffs, and Governed Memory

Affected schema:

- Add public WorkGraph Role IDs and Role Contracts for PM, Architect, Developer, QA, Security, and compatible legacy roles.
- Add Handoff recipients, memory scope, stable keys, optional expiration, constraints, and lessons.
- Add durable `work.task.handoff-routed.1` and the `work_handoff.recipients` projection column.
- Expose Role Contracts and directed Handoffs through Work HTTP APIs and generated clients.

Change:

- Bind organization roles to independent hidden Agents with role-specific tool permissions, workspace access, isolation, publishing, and consumption policies.
- Route Handoffs only to direct downstream Tasks and require the durable mailbox result before a dependency becomes runnable.
- Admit only explicitly promoted, keyed project records into Project Memory; deduplicate identical values, surface conflicting values without choosing one, and discard expired records.

Compatibility:

- Existing `build`, `general`, and `explore` Tasks remain valid through compatibility Role Contracts.
- Existing Handoff rows backfill an empty recipient list; the runtime durably reconciles missing routes for direct downstream Tasks.
- Handoff items without an explicit project scope remain Task-local and do not enter long-term Project Memory.

## 2026-08-06: Add Configurable WorkGraph Organizations and Memory Resolution

Affected schema:

- Add optional WorkGraph Role Contract configuration and persist the resolved contract array on every new Goal.
- Add `MemoryResolutionID`, governed Project Memory candidate/view contracts, and durable `work.project-memory.resolved.1`.
- Add `work_goal.role_contracts` and the append-only `work_memory_resolution` projection.
- Expose Goal organization snapshots, governed memory state, and conflict resolution through HTTP APIs and generated clients.

Change:

- Merge configured Role Contracts by role ID over built-in defaults, validate referenced Agents at Goal creation, and freeze the result for deterministic replay.
- Resolve conflicts only by selecting an active exact candidate whose project, stable key, Handoff digest, item digest, and expiry all validate.
- Preserve every accepted resolution with resolver, reason, source identity, and timestamp; the latest still-valid resolution governs the current memory view.

Compatibility:

- Existing Goal rows backfill an empty contract array and continue to use built-in Role Contracts.
- Existing Handoffs remain valid governed-memory candidates; no chat transcript is promoted implicitly.
- Configuration changes affect only newly created Goals and cannot mutate the organization contract of an existing Goal.

## 2026-08-06: Add Authenticated WorkGraph Worker Pull

Affected schema:

- Add nullable credential digest, creation, last-used, and revocation columns to the durable Worker registry.
- Add public Worker credential status, one-time enrollment result, assigned-Goal, and poll response contracts.
- Add Worker enrollment, credential rotation/revocation, authenticated heartbeat, and authenticated poll HTTP endpoints.
- No new synchronized Work event kinds are added; Goal placement and lease ownership continue to use the existing durable events and projections.

Change:

- Issue a high-entropy Worker token once while persisting only a Worker-bound SHA-256 digest; compare authenticated requests in constant time.
- Keep operator-owned draining state out of Worker heartbeat payloads so a credential holder cannot silently re-enable itself.
- Return only active Goals assigned to the authenticated Worker and refuse new lease acquisition when that Worker is absent, offline, draining, or lacks execute capability.
- Add `zaovra worker enroll` and `zaovra worker start` for an independent process that reuses the canonical WorkGraph, SessionV2, recovery, and fenced lease runtime.
- Detect a controller/Worker database mismatch before dispatching assigned work.

Compatibility:

- Existing Worker rows have null credential metadata and remain local Workers; no token can authenticate them until an operator explicitly rotates/enrolls a credential.
- Phase 7B requires the controller and Worker process to share SQLite/WAL state and accessible workspace roots.
- Cross-device Event replay, Artifact/patch transfer, Location mapping, remote log transport, and transport hardening remain Phase 7C work and are not implied by this change.

## 2026-08-07: Add Fenced Remote Agent Attempts

Affected schema:

- Add `agent` variants to the public Worker Job operation and result unions, carrying durable Session identity, Agent identity, bounded final response, provider/tool counts, outcome, and content digests.
- Extend Git diff capture with an optional prior workspace digest for exact repair continuation.
- No new Work durable events or relational columns are added; Agent Jobs reuse the existing fenced Job, log, and Artifact projections.

Change:

- Dispatch execute/repair Attempts to a placement-selected remote Worker while retaining Goal, Task, Attempt, Evidence, Evaluation, and loop ownership on the controller.
- Run each remote Attempt through the canonical durable SessionV2 provider/tool runtime in a Worker-isolated database, including the normal model, MCP, ToolRegistry, Context Epoch, and permission services.
- Stream bounded Agent step, tool, and text progress through the ordered Job log and bind the final response plus cumulative Git patch to SHA-256 digests before completion.
- Require a clean fixed revision for the first Attempt and the previous cumulative patch digest for repair; apply the final patch on the controller only after verification/review and only when no local drift exists.
- Make WorkGraph-specific Agent permissions non-interactive by denying questions, external directories, and sensitive environment files.

Compatibility:

- Existing command/file Worker Jobs and stored Job JSON remain valid because the new operation/result variants and prior digest are additive.
- Shared-mode and unplaced Goals continue to execute their Agent Sessions locally.
- Remote Agent execution currently requires a Git workspace; non-Git work falls back to the existing local Session path.
- A lost leased Agent Job remains `unknown` and is not automatically replayed. Rebinding and continuing the Worker-local Session after disconnection is a later production-distributed slice.
