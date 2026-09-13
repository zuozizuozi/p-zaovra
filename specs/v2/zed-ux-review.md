# Zed UX refinement — 2026-09-14

## Scope and principles

Reference: [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel). Learn task visibility, safe intervention, review and quiet notifications; retain Codex as the primary desktop interaction reference required by AGENTS.md.

Four batches were implemented in the existing Solid UI. No new frontend framework, runtime orchestration layer, model-specific branch, dependency or public API was introduced. Existing durable input admission, permissions, review modes and session state remain authoritative. Full product acceptance testing is deferred as requested.

## Implemented

1. **Task visibility:** tab avatars expose localized permission/question/running/error/unread/idle descriptions; question requests also take precedence over the legacy sidebar spinner. Shell-start events refresh projected history. Shell records without a completion timestamp produce a separate hint, without claiming that an orphaned process is alive or complete.
2. **Intervention:** queued drafts support removal through the existing cancellation path. Manual send uses steer delivery for both admitted and local drafts, with copy explaining the next safe boundary. Removal and local state cleanup complete before automatic admission is unblocked. Permission details expose the remembered patterns and hide persistent approval when no patterns can be saved. Approval/question errors preserve the current reading position; successful responses alone trigger completion feedback.
3. **Review:** list and file-detail failures have in-place retry; loading is distinct from empty results. Empty copy follows the selected worktree/branch/turn scope. Filtering has a specific no-match message and a clear action. Existing file review, comments and mode navigation are reused.
4. **Consistency:** the queue header is one native keyboard-accessible button with expansion state. Questions avoid taking initial focus away from another focused region. Completion/error notifications retain their history entry but do not play sounds or show system notifications while the user is actively viewing that session.

## Verification

- App package `bun typecheck`: passed.
- Focused tests: 19 passed across the session adapter, diff helpers, follow-up HTTP flow and review sidebar state. One new adapter case distinguishes missing and present shell completion records.
- Production build and existing V2 session-switch benchmark: passed before and after, one cold/hot sample each with review closed/open. All blank, wrong-session, unknown-content and review host replacement/missing samples were zero.
- Reviewed the production benchmark screenshot with the review pane open. This does not constitute exhaustive visual coverage of every dock or error state.
- Impeccable detector over changed app files: no findings. Diff whitespace check passed.
- The benchmark fixture needed an explicit `/api/usage` response before the baseline could run. No unknown routes were suppressed.
- An accidentally invoked root typecheck failed in the unchanged Slack package (`src/index.ts:78,96`, missing `ZaovraClient.session`). This is not an app typecheck failure and remains outside this UX change.

| Review | Sample | First correct before → after (ms) | Stable before → after (ms) |
|---|---|---|---|
| Closed | Cold | 9.1 → 11.5 | 40.9 → 43.8 |
| Closed | Hot | 4.9 → 3.6 | 29.9 → 22.3 |
| Open | Cold | 25.7 → 24.7 | 46.3 → 54.0 |
| Open | Hot | 18.2 → 20.1 | 42.4 → 43.9 |

Single samples establish a smoke baseline, not a statistically supported performance improvement. Raw logs were retained in the local temporary directory as `zaovra-zed-before.log` and `zaovra-zed-after.log`.

## Remaining product acceptance

Exercise slow/disconnected providers, route changes during replies, competing queued input promotion/cancellation, review request failures, narrow windows and screen-reader interaction against a real backend. Verify platform notifications on the packaged desktop only when release or packaging verification is requested.

Unfinished shell hints depend on loaded session history. They are not a process monitor, crash recovery mechanism or a complete inventory of all background work. This phase intentionally adds no editor rewrite, computer-use layer or duplicate navigation.
