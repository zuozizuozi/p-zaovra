import { describe, expect, test } from "bun:test"
import {
  clampSessionPanelWidth,
  REVIEW_PANE_WIDTH_MIN,
  REVIEW_PANE_WIDTH_MIN_SPLIT,
  SESSION_PANEL_WIDTH_MIN,
  sessionPanelWidthMax,
} from "./session-panel-width"

describe("sessionPanelWidthMax", () => {
  test("reserves the unified review pane minimum", () => {
    expect(sessionPanelWidthMax({ available: 1700, split: false })).toBe(1700 - REVIEW_PANE_WIDTH_MIN)
  })

  test("reserves a larger minimum for split diffs", () => {
    expect(sessionPanelWidthMax({ available: 1700, split: true })).toBe(1700 - REVIEW_PANE_WIDTH_MIN_SPLIT)
    expect(REVIEW_PANE_WIDTH_MIN_SPLIT).toBeGreaterThan(REVIEW_PANE_WIDTH_MIN)
  })

  test("leaves resize travel for split review at a typical desktop width", () => {
    const available = 1200
    const max = sessionPanelWidthMax({ available, split: true })
    expect(max).toBeGreaterThan(SESSION_PANEL_WIDTH_MIN + 100)
    expect(available - max).toBeGreaterThanOrEqual(REVIEW_PANE_WIDTH_MIN)
  })

  test("lets the chat panel take everything beyond the review pane minimum", () => {
    // Regression: the old cap was 45% of the window, forcing the review pane
    // to at least 55% of the window regardless of content.
    const available = 3440
    expect(sessionPanelWidthMax({ available, split: false })).toBeGreaterThan(available * 0.45)
  })

  test("never drops below the chat panel minimum on small windows", () => {
    expect(sessionPanelWidthMax({ available: 600, split: true })).toBe(SESSION_PANEL_WIDTH_MIN)
    expect(sessionPanelWidthMax({ available: 0, split: false })).toBe(SESSION_PANEL_WIDTH_MIN)
  })
})

describe("clampSessionPanelWidth", () => {
  test("allows dragging away from the minimum beside split review", () => {
    expect(clampSessionPanelWidth({ width: 570, available: 1200, split: true })).toBe(570)
  })

  test("keeps widths already within the limit", () => {
    expect(clampSessionPanelWidth({ width: 800, available: 1700, split: false })).toBe(800)
  })

  test("forces the width down when the window shrinks", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: 1700, split: false })).toBe(1700 - REVIEW_PANE_WIDTH_MIN)
    expect(clampSessionPanelWidth({ width: 1600, available: 1700, split: true })).toBe(
      1700 - REVIEW_PANE_WIDTH_MIN_SPLIT,
    )
  })

  test("holds the chat panel minimum when there is no room for both", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: 700, split: true })).toBe(SESSION_PANEL_WIDTH_MIN)
  })

  test("skips clamping before the layout is measured", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: undefined, split: false })).toBe(1600)
  })
})
