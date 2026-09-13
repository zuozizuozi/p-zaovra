# Session API

## Current V2 Core Slice

The Effect-native core facade treats prompt recording and execution as separate responsibilities:

```text
sessions.create({ id?, location, ... })
  -> omitted ID generates one internal Session ID
  -> supplied ID creates the Session when absent
  -> reused ID returns the existing Session identity

sessions.prompt({ id?, sessionID, prompt, delivery?, resume? })
  -> omitted ID generates one internal message ID
  -> supplied ID inserts one durable Session inbox row when absent
  -> exact reuse returns the same admission receipt
  -> reusing one message ID for another Session, prompt, or delivery mode fails
  -> exact retry schedules another wake unless resume is false
  -> resume omitted or true schedules execution after admission
  -> resume false admits only

sessions.interrupt(sessionID)
  -> interrupts active execution on this process
  -> waits for runner cleanup and settlement
  -> clears a coalesced follow-up wake already registered with this coordinator
  -> preserves durable inbox rows for a later wake or resume
  -> idle or missing Session is a no-op

sessions.active()
  -> snapshots foreground Session drains owned by this process
  -> returns only active Session IDs with { type: "running" }
  -> absence means inactive; activity is not durable across process restarts
```

`session_input` is the durable admission inbox. `PromptAdmitted` records and projects accepted input so pending queue state can be replayed, replicated, and observed by clients. Admitted inputs remain outside model-visible Session history until the serialized runner publishes `Prompted`. Its projector atomically writes the visible user message and marks the inbox row promoted in the same event transaction. The V1-to-V2 shadow bridge publishes the same `Prompted` event for already-visible V1 prompts.

`admittedSeq` is the durable Session event sequence of `PromptAdmitted`. Clients may use the admission event to represent queued input before `Prompted` makes it part of visible conversation history.

Execution routing starts from only the Session ID:

```text
SessionExecution.resume(sessionID)
-> SessionStore.get(sessionID)
-> LocationServiceMap.get(session.location)
-> SessionRunner.run({ sessionID, force? })
```

`SessionExecution` and the read-side `SessionStore` are process-global. `SessionRunner`, catalog, model resolver, tool registry, permission state, and filesystem are cached per Location. No layer takes a Session ID. An omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.

The local runner issues one explicit `llm.stream(request)` per provider turn, projects each complete local tool call durably, executes local calls in declaration order while provider streaming continues, awaits settlement after provider-stream closure, and reloads projected history once before continuation. A declined or interrupted invocation prevents queued calls from executing. Different Sessions remain concurrent. Promoting any new user input resets the selected agent's configured provider-turn allowance; multiple steers promoted at one boundary reset it once. Tool settlement events carry the owning assistant message ID because provider-local call IDs may repeat across turns. Before assembling a provider request, the runner durably fails any local tool still projected as `running` from a previous process with `Tool execution interrupted`; abandoned side effects are never silently replayed.

The final allowed provider turn disables local tools and records `max-steps`; model tool calls cannot extend that allowance. Output truncation, content filtering, and a stream that starts assistant output without completing its turn are recorded as failures. Child-task completion requires a settled assistant with `finish: stop` and no error; other stopped children retain an explicit incomplete explanation. This is an execution outcome, not proof that the user's acceptance criteria passed.

Loop protection compares consecutive local tool calls with stable JSON key ordering. Three identical calls may execute; the fourth is rejected with corrective feedback, and a fifth unchanged call stops the loop. An intervening different call or newly promoted input resets the counter, so repeated verification after edits remains possible. General cycles remain bounded by the provider-turn allowance.

Ordinary coding behavior is guided by the default build-agent prompt: inspect, make targeted changes, verify proportionately, repair using observed feedback, and report evidence and unresolved work. Simple questions can finish without tools. No mandatory completion tool or second-model judge is added without behavioral evidence that it improves this path; WorkGraph's independent verification remains a separate capability.

Projected hosted tools preserve call-side and settlement-side provider metadata separately so settlement and interruption recovery cannot erase continuation identifiers. Provider-native reasoning and provider metadata replay only while the historical assistant model matches the selected continuation model; after a model switch, visible reasoning text remains ordinary assistant text and provider-native metadata is omitted.

## Context Epochs

V2 Sessions persist the exact privileged System Context shown to the model. A Context Epoch stores one immutable provider-cache baseline and a model-hidden structured snapshot used to compare independently observed Context Sources. Environment facts, the host-local date, ambient global/upward-project `AGENTS.md` files, and selected-agent available-skill guidance are the initial sources. Location-wide sources come from the System Context Registry; selected-agent guidance composes with them immediately before Context Epoch admission.

The first complete observation initializes the epoch before any pending prompt becomes model-visible. If initial context is temporarily unavailable, execution stops while the prompt remains pending and retryable. On later provider turns, the runner promotes eligible input first, then reconciles current sources at the safe boundary. Changed context becomes one durable chronological System message, and its event commit advances the epoch snapshot atomically.

```text
Client            Runner                         System Context Registry       Context Epoch Store       Session History         LLM
   │                 │                                      │                           │                       │                 │
   ├─ Admit prompt ─────────────────────────────────────────────────────────────────────────────────────────────▶                 │
   │                 │                                      │                           │                       │                 │
   │                 ├─ Observe initial context ────────────▶                           │                       │                 │
   │                 │                                      │                           │                       │                 │
   │                 ◀─ Complete baseline or unavailable ───┤                           │                       │                 │
   │                 │                                      │                           │                       │                 │
   │                 ├─ Initialize missing epoch ───────────────────────────────────────▶                       │                 │
   │                 │                                      │                           │                       │                 │
   │                 ├─ Promote eligible input ─────────────────────────────────────────────────────────────────▶                 │
   │                 │                                      │                           │                       │                 │
   │                 ├─ Reconcile at safe boundary ─────────▶                           │                       │                 │
   │                 │                                      │                           │                       │                 │
   │                 ◀─ Unchanged or chronological update ──┤                           │                       │                 │
   │                 │                                      │                           │                       │                 │
   │                 ├─ Advance snapshot atomically with update ────────────────────────▶                       │                 │
   │                 │                                      │                           │                       │                 │
   │                 ├─ Baseline + chronological history ─────────────────────────────────────────────────────────────────────────▶
```

Agent and model selection are provider-turn scoped. A switch admitted after the current safe provider-turn boundary applies to the next provider turn without restarting the current turn or replacing the baseline. Agent-specific skill guidance remains a Context Source, so changed guidance is admitted as a chronological System message. A completed compaction causes the next provider attempt to render a fresh baseline directly from current complete context. A Session move clears the epoch so the destination Location initializes a complete baseline on its next run.

```text
Session                            Epoch
   │                                 │
   ├─ initialize complete baseline ──▶
   │                                 │
   │                                 ├─────────────────────────────────╮
   │                                 │ reconcile chronological update  │
   │                                 ◀─────────────────────────────────╯
   │                                 │
   ├─ completed compaction ──────────▶
   │                                 ├─ render fresh baseline
   │                                 │
   ├─ clear after Location move ─────▶
```

Ambient project discovery canonicalizes and contains traversal within the project root and honors `ZAOVRA_DISABLE_PROJECT_CONFIG`. An unavailable observation preserves the previously admitted value. A confirmed partial instruction removal emits the complete remaining aggregate with explicit supersession text; removing the final instruction emits a revocation message.

Current Context Epoch follow-ups:

- Add configured, remote, and nested instruction sources with explicit precedence and removal semantics.
- Add durable post-crash continuation recovery for promoted or provider-dispatched work.
- Add explicit manual compaction on top of automatic request-budget compaction.
- Add operational metrics for observation latency, unavailable sources, contention, baseline size, and chronological-update growth.
- Consider watcher-backed per-file caching only if measurements show direct safe-boundary observation is too expensive.
- Expose plugin-defined Context Sources only after plugin reload and scoped cleanup semantics are designed.
- Add clustered Session execution ownership and stale-runtime fencing.

## Automatic Compaction

Before each provider turn, the runner estimates the complete model-visible request and compares it with the selected model's context window minus absolute reserved headroom. The reserve is the greater of the requested/model output allowance and configured `compaction.buffer`. When the request exceeds that budget and older complete turns are available, the runner compacts before executing the pending turn.

Compaction keeps the full transcript durable while replacing its active model representation with one hidden checkpoint containing a structured rolling summary and token-bounded serialized recent context. Provider-native assistant, reasoning, and tool messages never survive across the boundary, avoiding signature and encrypted-reasoning failures when the earlier prefix changes.

`session.next.compaction.started.1` durably identifies the attempt. Compaction deltas are live-only progress. `session.next.compaction.ended.1` durably stores the final summary and serialized recent context; only this completed event projects a model-visible compaction message. On the next provider attempt, the runner observes that completed compaction and directly renders a fresh Context Epoch baseline. A failed or interrupted attempt therefore leaves the previous history boundary active.

Repeated compactions update the previous structured summary with newly compacted messages. The runner then reloads projected history and executes the original pending turn. Each logical provider turn permits at most one completed compaction, whether proactive or overflow-triggered; its rebuilt attempt cannot start another compaction. This bounds recovery even when system/tool overhead alone exceeds the available window.

The summary preserves the original objective, latest corrections, authorization boundaries, unfinished requirements, verification status, failed approaches, uncertain operations, and references to retained tool output. Serialized tool output retains its beginning and end with an explicit omission marker. A message split across summarized and recent context appears only once across the two regions.

Summary generation uses one provider call with a two-minute deadline. Only nonempty text with a normal stop can replace active history; timeout, truncated output, missing completion, and provider errors produce a failed compaction and retain the previous boundary. Automatic failure suppression tracks the latest non-checkpoint message, so newly completed assistant work permits a new attempt.

This adopts Terminus 2's explicit task handoff and bounded context recovery while retaining a single summary call instead of its three-stage summary/question/answer process. Reference: Harbor `fd0049126a060f930372f9b0b0aa330caf1f19e5`, `src/harbor/agents/terminus_2/terminus_2.py`. Real-model long-task acceptance remains deferred: repeated compaction with changed user constraints, truncated/slow summaries, retained output retrieval, and overflow with oversized system/tool context. Automatic crash replay remains out of scope.

Summary preparation first tries ordinary history, then one deterministic reduced representation if the serialized summary message exceeds the context budget after reserving output. Reduction omits assistant reasoning, bounds assistant text and tool arguments, and shortens tool/shell output with explicit omission markers. It preserves user messages, system updates, shell commands, tool errors, retained output references, and the previous checkpoint. The latest user request is also supplied explicitly to update the objective even when it remains in recent context. These are input-preservation rules, not guarantees that a model will produce a lossless summary. If reduction moves all new history into the recent allowance, that history is summarized once instead of creating a duplicate recent block. If protected content still does not fit, no summary request is sent and active history remains unchanged; no failed provider call is invented for usage accounting.

Deferred acceptance also covers large tool arguments/reasoning, unchanged user corrections during fallback, and input too large even after reduction. Background shell launch/observe/wait/cancel belongs to the later execution-engineering review; existing background subagent Sessions do not imply this shell capability is implemented.

When a provider rejects a request as context overflow before durable assistant output or tool execution, the runner attempts one overflow-triggered compaction even when the local estimate did not predict pressure. A completed checkpoint rebuilds the same logical provider turn with one remaining physical attempt. A second overflow, unavailable compaction, or overflow after durable output becomes the ordinary terminal failure; recovery never loops or replays partial side effects. Deterministic old tool-result pruning remains a separate follow-up.

## V1 Runtime Context Parity

This is the canonical checklist for model-visible runtime context still needed before the V2 runner replaces V1. Keep each behavior in its owning boundary rather than treating all model-visible text as a durable Context Source. Update this table in the PR that changes a status.

Status: `complete` is usable in the native V2 path, `partial` covers only part of V1 behavior, and `missing` has no native V2 equivalent.

| Boundary                   | Behavior                                                                 | Status   | Remaining V2 work                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Durable Context Source     | Environment facts and host-local date                                    | partial  | Add selected provider/model identity without making model selection a stale Location-wide value.                                       |
| Durable Context Source     | Global and upward project instructions                                   | partial  | Decide whether V2 also discovers legacy `CLAUDE.md` and deprecated `CONTEXT.md`.                                                       |
| Durable Context Source     | Configured local/glob and remote URL instructions                        | missing  | Add independent sources with explicit precedence, unavailable, and removal semantics.                                                  |
| Durable Context Source     | Nearby nested instructions discovered after successful reads             | missing  | Persist discoveries and admit them at the next safe provider-turn boundary.                                                            |
| Durable Context Source     | Selected-agent available skill guidance and skill-body loading           | partial  | Guidance and body exposure are permission-filtered; remove globally denied skill definitions during request-time tool materialization. |
| Per-turn request assembly  | Placement, selected model, chronological history, and canonical lowering | complete | None.                                                                                                                                  |
| Per-turn request assembly  | Selected agent, agent prompt, and effective permissions                  | partial  | V2 uses selected-agent permissions for skill guidance and tool authorization; still apply the agent system prompt and request policy.  |
| Per-turn request assembly  | Provider/model-specific base instructions                                | missing  | Select the provider-family baseline unless the effective agent overrides it.                                                           |
| Per-turn request assembly  | Policy-filtered built-in, MCP, plugin, and structured-output tools       | partial  | Materialize definitions for the effective agent and request.                                                                           |
| Per-turn request assembly  | Per-prompt system text and tool overrides                                | missing  | Design admission and durable replay semantics before exposing them.                                                                    |
| Per-turn request assembly  | Steering, plan/build-switch, and final-step reminders                    | missing  | Add only reminders whose behavior remains part of V2.                                                                                  |
| Per-turn request assembly  | Plugin message, system, parameter, and header transforms                 | missing  | Design V2 plugin hooks and lifecycle semantics.                                                                                        |
| Per-turn request assembly  | Model variants and request settings                                      | partial  | Apply effective agent options and future plugin-mutated request settings.                                                              |
| Per-turn request assembly  | Structured-output policy                                                 | missing  | Add prompt format, generated tool, tool choice, and model-visible policy together.                                                     |
| Per-turn request assembly  | Automatic/context-pressure compaction                                    | complete | V2 initiates automatic and overflow-triggered compaction, then rebuilds the baseline from the completed checkpoint.                    |
| Prompt/reference expansion | Durable typed prompt attachments                                         | complete | None.                                                                                                                                  |
| Prompt/reference expansion | Native template and `@` mention expansion                                | missing  | Parse and resolve native V2 prompt input before durable admission.                                                                     |
| Prompt/reference expansion | File, directory, media, and MCP-resource materialization                 | partial  | Materialize and normalize sources instead of lowering unresolved attachment metadata.                                                  |
| Prompt/reference expansion | Agent-reference expansion                                                | missing  | Produce permission-aware model-visible task guidance.                                                                                  |
| Prompt/reference expansion | Configured-reference expansion                                           | missing  | Resolve aliases and emit durable model-visible reference context or failures.                                                          |
| Prompt/reference expansion | Native synthetic expansion replay                                        | partial  | V2 replays synthetic messages but only the V1 compatibility path creates them.                                                         |

Provider timeout, retry, and watchdog policy is intentionally deferred. The runner does not impose a universal provider-stream inactivity or absolute timeout. A future slice should design configurable policy around provider behavior, durable failure reporting, and local drain-chain release rather than hardcoding one default for every provider.

Inbox delivery is explicit:

- `steer` inputs promote at the next safe provider-turn boundary, including continuation inside the current drain.
- `queue` inputs remain in a FIFO while the current drain requires continuation. When the Session would otherwise become idle, the runner promotes exactly one queued input, then reevaluates continuation before promoting another.

Execution has two entry points:

- `run` is an explicit resume. It joins any active execution or starts a forced drain while idle. A forced drain bypasses the no-eligible-input guard, but preparation may still fail before a provider attempt.
- `wake` reports newly recorded durable inbox work. Repeated wakes coalesce. A wake calls the provider only when it can promote eligible input.

Post-crash continuation recovery is intentionally deferred. A wake does not infer that ambiguous provider work is safe to retry after an input has already been promoted. Explicit `run` may deliberately continue from durable projected history. A future recovery slice should model provider-dispatch ambiguity, required continuation, queued-input promotion, retry policy, and visible recovery status together. It must not assume an enclosing durable execution identity that the Session model does not otherwise need.

A process-global `SessionRunCoordinator` serializes execution for each local Session while allowing different Sessions to run concurrently. Resumes join active execution, overlapping wakes coalesce into one follow-up, and interruption stops current process-local execution without deleting durable inbox work. The runner enters the Session's current Location when execution starts and fences each new provider turn against that Location.

The coordinator's active registry is also the source for `sessions.active()`. It represents only foreground Session drains owned by the current process; background subagents and tasks do not add parent Sessions to this registry. The snapshot is runtime state and is empty after a process restart.

Inbox promotion coalesces pending steers in durable admission order. Once continuation would otherwise end, it promotes one queued input at a time in FIFO order. Add explicit inbox backlog and steering-batch limits before exposing broad multi-caller admission or untrusted queue growth.

Eager local-tool execution is intentionally unbounded in the current local slice. This minimizes tool latency but does not increase SQLite settlement throughput: Session-event publication remains serialized per provider turn. Before broadening exposure, revisit per-turn call limits, output truncation, and operational backpressure using observed workloads. The `session.next.*` event schemas remain experimental and unshipped; databases created by earlier experimental builds are disposable rather than compatibility targets.

The synchronized `session.next.*` event family and projected Session-message model predate this branch. This slice refines their replay contract: projected Session messages retain their source aggregate sequence so canonical context ordering and `sessions.messages(...)` pagination follow durable event order even when caller-supplied IDs or timestamps do not. Consumers can use `sessions.events({ sessionID, after? })` to replay durable `session.next.*` events after an aggregate sequence cursor, then tail durable events without a race. Live-only text, reasoning, and tool-input fragments remain available through EventV2 subscriptions for connected renderers; they are intentionally absent from the replayable Session stream.

The first `sessions.events(...)` contract is durable-only during both replay and live tailing. This keeps one cursor equal to one persisted aggregate sequence and is sufficient for reconnect-safe consumers. A later UI-facing API may optionally interleave live-only deltas while connected, but those fragments must remain explicitly ephemeral: they cannot advance the durable cursor, replay after reconnect, or be mistaken for publication boundaries.

`sessions.history({ sessionID, after?, limit? })` is the finite counterpart for request/response consumers. `after` is an exclusive aggregate sequence, and omission starts before sequence zero. The response is `{ data, hasMore }`; callers derive the next `after` from the final event's durable sequence when `hasMore` is true. Public durable Session events are selected before pagination, which permits gaps from private or historical aggregate events while preserving strictly increasing unique sequences. The log has a moving head, so events committed between pages may appear on the next page.

The finite endpoint is `GET /api/session/:sessionID/history`, uses the normal Session Location and authorization middleware, defaults to 50 events, and accepts at most 100. It returns only events in the public durable Session schema. The existing `sessions.events()` replay-and-tail stream is unchanged.

Durable event tail wakeups are advisory and edge-triggered. Each active tail owns one sliding-capacity-1 dirty signal for its aggregate and re-queries SQLite after a wake. Repeated commits coalesce while the tail is busy because durable rows, not in-memory notifications, preserve every event and sequence. Subscribe and register the dirty signal before historical replay, then remove it when the tail closes, so replay handoff cannot miss a commit and inactive aggregates retain no wake state.

Event replay owner claims are separate from clustered Session execution ownership. The former already fences synchronized projection reconstruction; the latter still needs distributed active-run acquisition, stale-runtime rejection, interruption, and placement orchestration.

## Current Tool Registry Slice

`ApplicationTools` stores process-scoped application registrations shared by all Locations. Each Location-scoped `ToolRegistry` overlays Location registrations, materializes definitions, and owns lookup and settlement. Closing a contribution scope removes its definition and rebuilds the advertised catalog. Trusted tool executors capture and perform authorization; the registry applies catalog visibility filtering, decodes input, invokes the retained handler, validates output, and settles failures as typed tool-result errors.

When a Session omits `agent`, both execution and permission evaluation use the default `build` agent. A caller must not observe `build` model behavior while permission checks silently evaluate an empty no-agent policy.

The first built-in contribution is bounded `read`:

```text
resolve one path relative to the Location or a named project reference
-> reject absolute paths, path escapes, and symlink escapes
-> authorize read against the canonical resource identity
-> for a file: return UTF-8 text or base64 binary content; page oversized UTF-8 text by bounded line ranges
-> for a directory: return direct children in directory-first alphabetical order
-> page directory results with one-based offset and next cursor
```

V2 `bash` uses the normal permission semantics: configured agent rules plus saved project approvals, with `ask` as the default when no rule matches. Bash is not sandboxed: the spawned shell runs with the host user's filesystem, process, and network authority. Structured external `workdir` resolution remains an enforced `external_directory` authority check. Best-effort scans of absolute command arguments produce advisory warnings only; they are not sandbox boundaries and do not request or enforce `external_directory` approval.

Bash publishes bounded output checkpoints at most once per second when output arrives. Combined process capture retains the beginning and latest output within its 1 MiB budget; timeout settlements retain that capture, and execution errors preserve their concrete cause. The Tool Registry still owns model-output bounding and managed retention. Output beyond the process-capture budget is explicitly marked lost; this does not introduce unlimited log storage or background command recovery.

The first V2 `apply_patch` leaf supports add, update, and delete hunks. It parses every hunk, resolves every mutation target, approves external directories, approves one edit batch, and preflights approved update/delete targets before committing operations sequentially. A later commit-time failure leaves earlier operations applied and returns an explicit partial-application report. Moves and atomic rollback remain separate follow-ups rather than implied behavior.

### Current Runner Follow-Ups

- Preserve ordered local-tool settlement. Introduce read-only parallelism only when measured latency justifies a small, explicit eligibility rule.
- Buffer or coalesce streamed deltas before rewriting growing assistant projections.
- Revisit additional covering indexes as larger-history query shapes become concrete.
- Design any global multi-Session event stream separately; the finite history API deliberately reads one authorized Session aggregate and does not change global Event publication.
- Decide whether UI-facing Session subscriptions should optionally interleave ephemeral deltas while connected without advancing the durable cursor.
- Add provider-aware context control for provider-executed tool results. Generic text truncation cannot replace provider-native structured payloads that must round-trip exactly.

## Remove Dedicated `session.init` Route

The dedicated `POST /session/:sessionID/init` endpoint exists only as a compatibility wrapper around the normal `/init` command flow.

Current behavior:

- the route calls `SessionPrompt.command(...)`
- it sends `Command.Default.INIT`
- it does not provide distinct session-core behavior beyond running the existing init command in an existing session

V2 plan:

- remove the dedicated `session.init` endpoint
- rely on the normal `/init` command flow instead
- avoid reintroducing `Session.initialize`-style special cases in the session service layer
