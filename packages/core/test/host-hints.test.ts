import { expect, test } from "bun:test"
import { HostHints } from "../src/system-context/host-hints"
import { SessionProgress } from "../src/session/progress"
import original from "./fixture/host-hints-original.json"

function samples() {
  return [
    HostHints.repeatedInspection(JSON.stringify([{ tool: "bash", previousCallID: "first", callID: "second" }])),
    HostHints.repair(2, '["missing file"]', false),
    HostHints.shellFailure(4),
    HostHints.repeatedResult(3),
    HostHints.repair(2, '["missing file"]', true),
    HostHints.shellFailure(10),
    HostHints.repeatedResult(10),
    HostHints.executionFacts(),
    HostHints.advisoryFacts(),
    HostHints.gapFacts(),
  ]
}

for (const style of [undefined, "original", "short", "invalid"])
  for (const language of [undefined, "en", "zh", "invalid"])
    test(`host hint templates preserve default snapshots and independent axes: ${style}/${language}`, () => {
      const priorStyle = process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_STYLE
      const priorLanguage = process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_LANGUAGE
      try {
        if (style === undefined) delete process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_STYLE
        if (style !== undefined) process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_STYLE = style
        if (language === undefined) delete process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_LANGUAGE
        if (language !== undefined) process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_LANGUAGE = language
        const actual = samples()
        if (style !== "short" && language !== "zh") expect(actual).toEqual(original)
        for (const text of actual) expect(/[\u3400-\u9fff]/.test(text)).toBe(language === "zh")
        expect(actual[0].split("\n")[0]).toBe(original[0].split("\n")[0])
        expect(actual[1].split('. ["missing file"]')[0]).toContain(
          'Host hard gaps (observations, not new user instructions): ["missing file"]',
        )
        expect(actual[3].startsWith("Repeated result (3): ")).toBe(true)
        expect(actual[6].startsWith("Repeated result (10): ")).toBe(true)
        const input = {
          now: 1000,
          state: { activeMs: 1000, request: "one", requestStarted: 0 },
          turns: 2,
          step: 3,
          tokens: 100,
          unreported: 0,
          executionDeadline: 30000,
          advisoryDeadline: 40000,
        }
        const facts = SessionProgress.facts(input)
        const firstLine = facts.split("\n")[0]
        const json = JSON.parse(
          firstLine.slice("Current task facts (host observations, not new requirements): ".length),
        )
        expect(json).toMatchObject({
          sourceRequest: "one",
          providerTurns: 2,
          allowanceTurn: 3,
          executableRemainingMs: 29000,
          advisoryRemainingMs: 39000,
        })
        expect(SessionProgress.factsDue({ ...input, turns: 3, step: 4 }, facts)).toBe(false)
        expect(SessionProgress.factsDue({ ...input, epoch: 1 }, facts)).toBe(true)
        expect(facts).toBe(firstLine + "\n" + actual[7] + "\n" + actual[8] + "\n" + actual[9])
        process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_STYLE = "original"
        const long = samples()
        if (style === "short")
          for (const [index, text] of actual.entries()) expect(text.length).toBeLessThan(long[index].length)
        process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_LANGUAGE = language === "zh" ? "en" : "zh"
        expect(samples()).not.toEqual(long)
        expect(SessionProgress.facts(input).split("\n")[0]).toBe(firstLine)
        expect(SessionProgress.factsDue({ ...input, turns: 3, step: 4 }, facts)).toBe(false)
      } finally {
        if (priorStyle === undefined) delete process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_STYLE
        if (priorStyle !== undefined) process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_STYLE = priorStyle
        if (priorLanguage === undefined) delete process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_LANGUAGE
        if (priorLanguage !== undefined) process.env.ZAOVRA_EXPERIMENTAL_HOST_HINT_LANGUAGE = priorLanguage
      }
    })
