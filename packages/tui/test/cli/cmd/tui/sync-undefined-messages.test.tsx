/** @jsxImportSource @opentui/solid */
/**
 * Reproducer for #26560 — TUI crashes with
 *   `TypeError: undefined is not an object (evaluating 'f.data.map')`
 * when entering a session whose messages endpoint returns a non-2xx.
 * The failure path is `sync.tsx#sync.session.sync` reading
 * `messages.data!` while the SDK leaves `data` undefined on error.
 */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount } from "./sync-fixture"

const sessionID = "ses_undef"

describe("tui sync (#26560)", () => {
  test("entering a session whose messages endpoint errors does not crash sync", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionPayload = {
      id: sessionID,
      title: "broken",
      projectID: "proj_test",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
      location: { directory },
    }
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: sessionPayload })
      if (url.pathname === `/api/session/${sessionID}/message`) return json({}, { status: 500 })
      if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
      return undefined
    }, tmp.path)

    try {
      await expect(sync.session.sync(sessionID)).resolves.toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })
})
