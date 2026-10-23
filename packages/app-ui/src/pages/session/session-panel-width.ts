// The review pane has no width of its own: it takes whatever the chat panel
// leaves behind. Reserve its preferred minimum on large windows, but let that
// minimum shrink on smaller ones so it does not pin the chat resize handle.
export const SESSION_PANEL_WIDTH_MIN = 450
export const REVIEW_PANE_WIDTH_MIN = 480
export const REVIEW_PANE_WIDTH_MIN_SPLIT = 800

export function sessionPanelWidthMax(input: { available: number; split: boolean }) {
  const pane = Math.min(input.split ? REVIEW_PANE_WIDTH_MIN_SPLIT : REVIEW_PANE_WIDTH_MIN, input.available / 2)
  return Math.max(SESSION_PANEL_WIDTH_MIN, input.available - pane)
}

// `available` is undefined until the layout row is first measured; render the
// stored width untouched until then to avoid a first-frame snap.
export function clampSessionPanelWidth(input: { width: number; available: number | undefined; split: boolean }) {
  if (input.available === undefined) return input.width
  return Math.min(input.width, sessionPanelWidthMax({ available: input.available, split: input.split }))
}
