import assert from "node:assert/strict"

export function requireContinuousResizeFollow(samples) {
  assert(samples.length > 0, "native resize follow samples exist")
  const unpinned = samples.filter((sample) => sample.distance > 2)
  assert.equal(
    unpinned.length,
    0,
    `native resize must stay pinned continuously; ${unpinned.length} gaps, max ${Math.max(...samples.map((sample) => sample.distance))}px`,
  )
}
