# V2 preflight repair review

## Implementation scope

1. Request assembly now uses selected-agent instructions, permissions, model defaults and request settings, plus a provider-neutral coding baseline and current provider/model identity. Local file, directory and media attachments are read under Location permissions and successful contents are snapshotted for replay. Unsupported remote/resource URLs produce explicit unavailable attachment text. Text files are capped at the attachment reader's 8 MiB limit; directory listings expose their 2,000-entry truncation. Native model media support remains protocol/model dependent.
2. PowerShell uses UTF-16LE encoded scripts, explicit UTF-8 output and exit propagation. Working directories are separate arguments. Existing cmd invocation remains supported. Windows tree termination invokes taskkill.exe with an argument array. Real Windows tests cover Unicode/spaced paths, quoting, native failure codes and timeout cleanup of a spawned child. Parser-based shell approval and stronger OS containment remain separate work.
3. Managed tool output gets stable, Session-owned Evidence IDs. evidence_read and evidence_search read original UTF-8 bytes in bounded pages, with offsets, pagination, retention errors and producer state. Search is literal and paged. Complete original logs remain on disk; model previews point to Evidence IDs. No semantic summarizer, search index, execution wrapper or token-count quota was introduced. Background output after lost process-local job state is conservatively outcome_unknown.
4. Outcome is separate from a provider stop. Completed local Bash checks carry kind, command, call ID, actual exit code and a workspace snapshot only when unchanged across execution. The minimal verified state requires successful build, test and lint against the current snapshot. A subsequent failure supersedes an earlier success; changed or unavailable snapshots remain unverified. Typecheck is recorded separately. This is evidence of these checks, not proof of every user acceptance criterion. Simple package-manager check commands are recognized; other verification commands use the explicit verification argument. Background verification is rejected. The UI and child task results expose the distinction.
5. Durable transcript inspection detects unfinished visible execution without waking it. Explicit continue/retry/abandon runs under existing Session coordination with a last-message guard. Continue admits inspection-first guidance, retry admits the original request anew, and abandon cancels pending inputs and archives the Session. No startup tool/shell replay was added. This is not automatic durable continuation or automatic safe-retry classification.
6. Local verification is complete for the targeted changes. Real external BYOK model acceptance remains pending usable user configuration; no external model run is claimed.

## Verification evidence

- Final Core focused suite: 178 passing tests across 11 files, with 544 assertions, after all outcome/recovery changes.
- LLM protocol suites: 109 passing tests for Responses, compatible Chat and Anthropic Messages. These are local protocol tests, not paid provider calls.
- Package type checks: Schema, Core, Protocol, Server, Client, app-ui and legacy JavaScript SDK.
- Public clients regenerated using packages/client generation and the legacy SDK build script.
- app-ui production-build session-switch benchmark passed before and after the UI changes; the targeted design detector returned no findings.
- Single-run stable-switch timings (milliseconds), before → after: review closed cold 25.8 → 68.4, closed hot 36.3 → 36.4, review open cold 37.9 → 72.5, open hot 44.5 → 45.6. No wrong/blank destination samples were recorded in the after run. Cold timings increased; one run cannot establish a reliable performance trend. Do not describe this as a demonstrated speed improvement.

### Cold-switch regression investigation

The follow-up identified a regression in the new outcome UI. Solid Query reads an unresolved query through a Solid resource. Reading `query.data` in SessionOutcomeDock without a local Suspense boundary propagated the wait into the layout's page-wide Suspense boundary. A cold destination therefore waited for the outcome response before displaying its conversation. Cached hot destinations did not have the same dependency.

The fix is a local Suspense boundary around SessionOutcomeDock. Outcome requests and verification semantics are unchanged; only the status panel waits for its response.

Production Chromium benchmarks ran serially, five fresh-browser trials per scenario before and after this fix. Median stable-switch times in milliseconds:

| Scenario            | Before fix | After fix |
| ------------------- | ---------: | --------: |
| Review closed, cold |       79.2 |      30.8 |
| Review open, cold   |       98.0 |      46.7 |
| Review closed, hot  |       29.0 |      23.9 |
| Review open, hot    |       42.2 |      41.3 |

An opt-in 1,500 ms outcome-response delay reproduced cold-switch times of 1,562.6 ms and 1,590.2 ms before the fix; after the fix they were 28.8 ms and 42.6 ms despite the same delayed responses. A separate passing regression scenario holds the target outcome response unresolved and requires the target conversation to render before releasing it, then requires the final outcome text to appear. These checks assert behavior rather than machine-dependent timing thresholds. The app-ui type check also passed.

Reproduce using the production performance harness, selecting `v2 session tab switching|renders a cold destination`, with `SESSION_TAB_SWITCH_RUNS=5`. Set `SESSION_OUTCOME_DELAY_MS=1500` for the diagnostic delay experiment. Raw output is retained in the local temporary directory under `zaovra-outcome-baseline5.log`, `zaovra-outcome-fixed5.log`, `zaovra-outcome-delay-before.log`, and `zaovra-outcome-delay-after.log`.

## Remaining acceptance and boundaries

- Configure BYOK through the application, then exercise a complete task, attachments, a long retained log, failed verification and interrupted-task recovery with actual provider responses. Do not send credentials in a chat message.
- V2's existing native provider routes are Responses, compatible Chat and Anthropic Messages. Provider-neutral policy does not mean every provider protocol or media combination has been implemented or verified.
- Remote/MCP attachment materialization, plugin request transforms, per-prompt policy overrides and richer structured-output admission are still separately scoped features. Their legacy parity gaps are not declared closed here.
- Attachment snapshot files and Evidence metadata currently have no dedicated metadata garbage collector. Evidence reads enforce original-output expiry; snapshots preserve successful attachment bytes for replay. Long-term metadata lifecycle should be addressed with Session data cleanup.
- Outcome refresh is event/focus/manual driven. It cannot continuously certify a workspace while unrelated external processes modify files. Without usable workspace snapshots, completion stays unverified.
- Tests did not include native installer packaging, multi-host execution, a full product manual acceptance pass, or real external BYOK calls.
