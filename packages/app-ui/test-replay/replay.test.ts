import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { dropped, pageThrough, repeated, replay, swapped } from "./driver"
import { wire, type Fixture } from "./kernel"

const directory = new URL("./fixtures/", import.meta.url)
const fixtures = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .toSorted()
// Disturbed delivery multiplies run time; two sessions with failures and retries cover it.
const disturbed = new Set(["deepseek-error-turns.json", "timeline-crash-session.json"])
const ownership = (rule: string) => rule.startsWith("I3 owner") || rule.startsWith("I6")

test("30 tool calls in one recorded turn require zero message-page reloads", async () => {
  const fixture: Fixture = await Bun.file(new URL("gpt-stop-resume.json", directory)).json()
  const start = fixture.events.findIndex((event) => event.id === "evt_1cdebce77001TI2s0vqDzXpXHC")
  const end = fixture.events.findIndex((event) => event.id === "evt_1cdf16fb4001m91VNAh7IKguqn")
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const turn = fixture.events.slice(start, end + 1)
  expect(turn.filter((event) => event.type.startsWith("session.next.prompted."))).toHaveLength(1)
  expect(turn.filter((event) => event.type.startsWith("session.next.tool.called."))).toHaveLength(30)
  expect(turn.filter((event) => /\.tool\.(success|failed)\./.test(event.type))).toHaveLength(30)
  const cut = { ...fixture, events: fixture.events.slice(0, end + 1) }
  const result = await replay(cut, { openAt: wire(cut).findIndex((event) => event.id === turn[0]!.id) })
  expect(result.checks).toBeGreaterThan(0)
  // The recording stops mid-turn, so its final execution state can still be busy.
  expect(Object.keys(result.violations).filter((rule) => rule !== "I5 not idle")).toEqual([])
  expect(result.requests.messages).toBe(0)
  expect(result.requests.history).toBe(0)
}, 300_000)

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

    // Invariant 1: following a session costs no history reads, however many tools it calls.
    test("followed live: never re-reads history pages", async () => {
      const result = await run("requests")
      expect({ messages: result.requests.messages, history: result.requests.history }).toEqual({
        messages: 0,
        history: 0,
      })
    }, 300_000)

    test("followed live: equal to kernel history after every event, mid-step and mid-sentence", async () => {
      const result = await run("dense", { dense: true })
      expect(result.checks).toBeGreaterThan(result.events / 2)
      expect(result.violations).toEqual({})
    }, 300_000)

    // Invariant 6.
    test("followed live: a reply never moves to another turn", async () => {
      expect((await run("ownership")).ownership).toEqual({})
    }, 300_000)

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
