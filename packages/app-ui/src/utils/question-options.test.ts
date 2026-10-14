import { expect, test } from "bun:test"
import { questionOptions } from "./question-options"

test("recommendations move first without changing the answer label or source order", () => {
  const options = [{ label: "A" }, { label: "B (Recommended)" }, { label: "C（推荐）" }]
  expect(questionOptions(options).map((item) => [item.label, item.displayLabel, item.recommended])).toEqual([
    ["B (Recommended)", "B", true],
    ["C（推荐）", "C", true],
    ["A", "A", false],
  ])
  expect(options.map((item) => item.label)).toEqual(["A", "B (Recommended)", "C（推荐）"])
})
test("recommendation text inside a label is not metadata", () => {
  expect(questionOptions([{ label: "Recommended architecture" }])[0]?.recommended).toBe(false)
})
