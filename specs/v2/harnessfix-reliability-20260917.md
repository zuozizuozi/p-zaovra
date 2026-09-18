# Trace-guided reliability investigation — 2026-09-17

## Scope and budget

User authorized autonomous end-to-end testing and local fixes with a new 1,500,000-token budget. Avoid large speculative refactors. Existing uncommitted changes belong to the previous investigation and remain intact.

The model under test is the existing configured `api-edgecloudapp-com-3/deepseek-v4-flash-0731`; no keys or raw authorization headers are exported. The test ledger starts at event rowid 3824, 2026-09-17T15:46:01Z. `quality/chain-audit/harness-budget.ts` counts durable step/compaction settlements including cached input and reasoning. Unreported calls retain a separate conservative reserve; it is not a bill or a guaranteed upper bound. The Codex goal budget is a separate account from these provider calls.

## Acceptance inventory

1. Fresh game creation: Zaovra creates an offline, usable keyboard brick breaker from an empty directory without external editing of the game. Check startup, left/right and A/D movement, launch, pause/repeat, blur, restart, scoring, three lives, at least three levels, final victory, defeat, replay, persistence, readable layout, and README.
2. Existing failure: reproduce and ask Zaovra to repair the old Orbit Breaker final-level crash; preserve original evidence. Report assistance separately from autonomous creation.
3. Follow-up editing: request a bounded feature/change in a working game, verify old behaviors as well as the addition.
4. Session control: actual input admission, model/tool execution, bounded argument recovery, stop/continuation, and UI/backend outcome agreement. Run relevant deterministic regressions; do not mistake them for live-model success.
5. Evidence: distinguish normal keyboard/browser actions from state-seeded edge tests. Inspect generated tests for false assertions. Record tokens, turns, failures, extra instructions, and exact limitations. Do not treat a generated JSON success report as independent evidence.

## Initial evidence

- Previous reports show the old 661,207-token game stopped at budget and has a final-level array overrun. Independently reproduced using its existing state hooks: `Cannot read properties of undefined (reading 'name')` after the final level transition. This is a generated-game defect, not proof of a session scheduler defect.
- Old prompt prohibited installing dependencies. The model implemented its own roughly 30KB CDP test driver and initially omitted the browser WebSocket UUID. New test separates offline game delivery from permitted development/test dependencies.
- Core baseline: 156 tests / 535 assertions pass across outcome, runner, message projection, efficiency, coordinator, and tool events. This does not establish successful delivery.
- First new session: `ses_f4ff3e6a8ffeODF6RkHAuzRSko`, directory `C:/Users/Administrator/Desktop/Zaovra-Harness-20260917/game-a`, request-boundary budget 420,000. Initial request submitted through the running desktop backend API. Desktop composer submission must be checked separately before end-to-end signoff.

## Results (completed local audit, 2026-09-18)

**The game-generation capability works in these samples, but reliable autonomous delivery is NOT established.** Two fresh requests produced playable games, yet both stopped before completing their own verification and README. Explicitly loading a browser skill did not rescue the second game's delivery within the available test allowance. Do not describe this as an end-to-end success or a measured efficiency gain.

| Run | Session | Recorded tokens | Outcome |
| --- | --- | ---: | --- |
| A: fresh game, before candidate changes | `ses_f4ff3e6a8ffeODF6RkHAuzRSko` | 462,536 | Budget stop; external checks pass, self-delivery incomplete |
| B: same prompt via actual desktop composer | `ses_f4fe84dc8ffe9dvwPWL3EX7sD0` | 431,216 | Budget stop after browser probe; skill advertised but not loaded |
| B recovery: explicitly load skill, finish existing game | `ses_f4fe2971affeOUlCuNKjO3eHte` | 394,599 + one unreported call | Found/fixed attached-ball tracking; interrupted during long bot test; no complete delivery |
| Old game: supplied exact final-level crash reproduction | `ses_f4fe0af96ffe3iAv5OpaKF6FIQ` | 207,453 | Minimal game fix; generated browser checks 7/7, malformed verification report and budget stop |

Reported total: **1,495,804** across 47 provider calls, **one call with missing usage**. Cache reads alone account for 1,299,072; input, visible output and reasoning account for the remainder. These are disjoint durable usage totals, not a monetary bill. The missing call cannot be treated as free. Actual total may exceed 1,500,000; the ledger retains a 100,000 uncertainty reserve rather than asserting the ceiling was met. All real-provider calls were stopped; the active-session API returned empty. No additional paid model requests were used to finish this audit.

The planned 260,000-token cap for the B recovery did not take effect: Location configuration was already cached at 420,000. A fresh Session in the same Location reused it. This was an experiment-control error as well as a misleading recovery instruction in the product. The old-game cap was loaded in a fresh Location at 180,000. Both caps are next-request stops, so a final in-flight request can cross the threshold. Future comparative runs must verify effective configuration before dispatch and reserve capacity for each active request; file edits alone are not a reliable live budget control.

## What changed in the default runtime

1. At 75% of an explicitly configured session budget, publish one durable reminder per limit into conversation history. It includes cached input and reasoning, preserves the system prefix, creates no extra provider call, and does not authorize skipped checks. It appeared in B's real trace. This proves delivery of the reminder, not improved task efficiency.
2. Preserve provider usage when cancellation occurs after provider completion while a local tool is still running. Previously interruption settled the assistant with zero tokens and missing usage, discarding the already-received settlement. The new path attaches usage only to that assistant message; interrupted status and failed tool settlement remain unchanged. Unknown usage stays unknown. Regression coverage checks cancellation, replay, and no duplicate accounting.
3. Budget-stop text and configuration documentation now explicitly require backend restart to reload changed Location configuration. No hot-reload mechanism or new scheduler was added.

The candidate `browser-verification` skill was tested as a builtin and subsequently **removed from default registration**. Its content is retained in `specs/v2/experiments/browser-verification/SKILL.md` for reproducibility. B ignored automatic skill discovery; explicit loading in recovery still failed to complete delivery. There is no evidence justifying shipping it as a reliability fix. Existing unrelated work from the previous task was preserved.

Validation: 165 passing tests / 570 assertions across runner, message projection, outcome, efficiency, coordinator, tool events, usage and builtin-skill suites. Core `bun typecheck` passes. Relevant budget and skill tests were rerun after the final wording/registration changes. Desktop sidecar rebuilt with `scripts/predev.ts`; ordinary development startup and backend health returned 200. No release package was generated. The cancellation accounting fix was tested deterministically, not with another paid provider request; it cannot reconstruct the historical lost usage.

## Playable artifact and independent checks

**Game A:** `C:/Users/Administrator/Desktop/Zaovra-Harness-20260917/game-a/index.html`.

Game HTML is entirely Zaovra/dsv4-generated; the audit did not edit its implementation. The external audit supplied `README.md` and `verify/independent-audit.mjs` after the original model session stopped. Run `node verify/independent-audit.mjs` from that directory with its existing Playwright dependency and installed Chrome. It produces 13 passing assertions and screenshots under `verify/audit-*`.

Coverage: offline file startup, arrow and A/D movement, launch, pause with real repeated keydown, blur handler and frozen ball state, restart, three-level final victory, victory replay, three lost lives and defeat replay, nonzero high-score persistence, narrow viewport fit, and no uncaught page exceptions. Final-stage and defeat checks use existing state hooks and actual game transitions; blur uses a dispatched event. This is not a claim of completing every stage by human play or cross-browser certification. Desktop layout was visually inspected. Mutation hooks remain available during normal play.

The model's own `verify/verify.mjs` returned 8/11 when run externally: held-P, blur HUD timing, and high-score-isolation assertions failed. Independent tests establish the narrower behaviors above, not that the original suite is correct. No failed checks were erased or relabeled. The authored audit README explicitly distinguishes external assistance from autonomous delivery.

**Game B:** independent keyboard/startup/layout checks pass 9/9. An initial fixed 180 ms arrow-motion assertion was flaky; it was corrected to wait for observed movement, preserving its expected behavior. The model found and fixed a separate real defect: an attached ball did not track the paddle in `ready` state. Final victory, defeat and persistence were not independently completed for B. Its bot run was interrupted, so it is not a passed acceptance test.

**Old game repair:** original `C:/Users/Administrator/Desktop/Zaovra-Orbit-Breaker-20260917/index.html` remains unchanged. Zaovra repaired a copy at `C:/Users/Administrator/Desktop/Zaovra-Harness-20260917/old-repair/index.html`. It moved the final-level guard before incrementing `levelIndex`; the last valid index is retained for HUD/state access. `node test/verify.mjs` independently reruns 7/7 checks, including the supplied reproduction, continuing animation, replay, normal stage advancement, an actual last-brick collision, all five stage boundaries and keyboard controls. The script uses seeded boundaries and an absolute local Playwright import. README was not delivered by the model.

The old-game shell call set `verification_report: true` but printed prose, despite the tool schema requiring a pure JSON object. The host correctly rejected certification. Do not loosen the parser to turn arbitrary `PASS` text into evidence. A follow-up feature-edit scenario was not attempted after the provider budget was exhausted.

## Assessment and next engineering decision

This follows [HarnessFix's trace-driven approach](https://github.com/HarnessFix/HarnessFix): reproduce a failure, identify the responsible boundary, make a scoped change, and verify the relevant regression. It does not treat adding a skill as a substitute for measuring outcomes.

Observed failure sources are mixed: generated-game defects; inefficient sequencing and oversized implementation/test plans; omitted skill loading; verification-report misuse; and real harness accounting/configuration issues. Basic prompt admission, tool execution, interruption and desktop-backend communication did operate during these tests. That does not prove all lifecycle paths are stable.

There is no matched baseline showing that replacing the kernel fixes these failures. Avoid another speculative rewrite. The next funded comparison should fix the same model, effective reasoning settings, request, test fixture and acceptance criteria across Zaovra and a candidate upstream runtime, then compare autonomous completion, intervention count, elapsed time and inclusive tokens. Further core changes should target an observed failure from that comparison. This audit does **not** justify a success-rate claim, a default skill rollout, or saying that the user's instability complaint has been fully resolved.

Local raw evidence is retained under the ignored `quality/chain-audit/` directory: token ledger, session traces, request fixtures, independent browser scripts/results/screenshots, generated-suite output, unit-test logs and development logs. These are local audit artifacts rather than portable checked-in fixtures; regression tests for shipped runtime behavior are in the repository's core test suite.
