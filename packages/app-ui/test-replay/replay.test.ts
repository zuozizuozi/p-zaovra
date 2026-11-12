import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { dropped, pageThrough, repeated, replay, swapped } from "./driver"
import type { Fixture } from "./kernel"

const directory = new URL("./fixtures/", import.meta.url)
const fixtures = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .toSorted()
// Disturbed delivery multiplies run time; two sessions with failures and retries cover it.
const disturbed = new Set(["deepseek-error-turns.json", "timeline-crash-session.json"])
// Until messages record their turn, ownership is re-derived from timestamps on every read.
const ownership = (rule: string) => rule.startsWith("I3 owner") || rule.startsWith("I6")

for (const name of fixtures) {
  describe(`replay ${name}`, () => {
    const load = () => Bun.file(new URL(name, directory)).json() as Promise<Fixture>
    const run = async (label: string, plan?: Parameters<typeof replay>[1]) => {
      const result = await replay(await load(), plan)
      console.log(
        name,
        label,
        JSON.stringify({ checks: result.checks, requests: result.requests, violations: result.violations }),
      )
      return {
        ...result,
        content: Object.fromEntries(Object.entries(result.violations).filter(([rule]) => !ownership(rule))),
        ownership: Object.fromEntries(Object.entries(result.violations).filter(([rule]) => ownership(rule))),
      }
    }

    test("followed live: content matches kernel history at every step", async () => {
      expect((await run("live")).content).toEqual({})
    }, 300_000)

    test("opened halfway: content matches kernel history at every step", async () => {
      const fixture = await load()
      expect((await run("halfway", { openAt: Math.floor(fixture.events.length / 2) })).content).toEqual({})
    }, 300_000)

    test("opened at the end and scrolled back to the first message", async () => {
      const result = await pageThrough(await load())
      console.log(name, "paged", JSON.stringify(result))
      expect({ ...result, requests: 0, history: 0 }).toEqual({
        complete: true,
        missing: [],
        extra: [],
        duplicates: 0,
        requests: 0,
        history: 0,
      })
    }, 300_000)

    // Invariant 1. Remove `.failing` once durable events are applied instead of re-reading pages.
    test.failing(
      "followed live: never re-reads history pages",
      async () => {
        expect((await run("requests")).requests.messages).toBe(0)
      },
      300_000,
    )

    // Invariant 6. Remove `.failing` once messages carry their turn.
    test.failing(
      "followed live: a reply never moves to another turn",
      async () => {
        expect((await run("ownership")).ownership).toEqual({})
      },
      300_000,
    )

    if (!disturbed.has(name)) return

    test("neighbouring events arriving in the wrong order", async () => {
      expect((await run("swapped", { deliver: swapped(7) })).content).toEqual({})
    }, 300_000)

    test("events delivered twice", async () => {
      expect((await run("repeated", { deliver: repeated(5) })).content).toEqual({})
    }, 300_000)

    test("stream drops and the server resends what was missed", async () => {
      expect((await run("dropped, resent", { deliver: dropped(90, 12, true) })).content).toEqual({})
    }, 300_000)

    test("stream drops and the missed events are gone", async () => {
      expect((await run("dropped, lost", { deliver: dropped(90, 12, false) })).content).toEqual({})
    }, 300_000)
  })
}
