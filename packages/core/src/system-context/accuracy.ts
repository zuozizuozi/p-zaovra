export * as AccuracyGuidance from "./accuracy"

export const general =
  "For forensic investigation, recovery or database repair, preserve the relevant original file group as a snapshot or working copy BEFORE investigating, and work on the copy. Include sidecar files and untracked inputs; a Git snapshot alone may omit them. An ordinary SQLite connection can checkpoint or consume WAL even when the intended query looks read-only; inspect raw bytes or use an appropriate read-only mode on a preserved copy. " +
  "When a result has an implausible magnitude or conflicts with an expected value supplied by the user, recheck units, input selection and conversions. This is a diagnostic reminder, not permission to change the conclusion. Never fabricate or fill in data to satisfy expected prefixes, example outputs or numeric ranges. Preserve uncertainty when source metadata is missing."

export const evidence =
  "Map every requirement to the actual checks and their coverage: content, structure, directories, types, metadata, input scale, non-example generalization and requested performance. Separate real dependencies from mock interface checks. After a failed run, an old artifact cannot establish a new successful result. Keep the latest failed user-requirement check or unmet checkable condition open until a relevant fresh rerun passes. Exit zero with FAIL output, module loading without executed assertions, and a passing surrogate implementation are not acceptance. If resources, permission or capability prevent further work, stop honestly with the reason and failed or unverified scope."

/** One advisory checkpoint; budget enforcement remains owned by the runner. */
export function checkpoint(input: { elapsed: number; limit?: number }) {
  if (
    !Number.isFinite(input.elapsed) ||
    input.limit === undefined ||
    !Number.isFinite(input.limit) ||
    input.limit <= 0 ||
    input.elapsed < input.limit * 0.5
  )
    return undefined
  if (input.elapsed >= input.limit) return undefined
  return `Wall-clock delivery checkpoint: ${Math.max(0, input.limit - input.elapsed)}ms remain. Save a version that meets basic requested acceptance before improving it. Choose training or build scale from the remaining time, preserve necessary validation, and do not label a partial artifact complete.`
}
