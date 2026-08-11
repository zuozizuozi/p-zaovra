/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@zaovra-ai/sdk/v2"
import { mount, wait } from "./sync-fixture"
import { tmpdir } from "../../../fixture/fixture"

test("bootstraps commands and replies to permissions through V2", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const paths: string[] = []
  const { app, emit, permission } = await mount((url) => {
    paths.push(url.pathname)
    if (url.pathname === "/api/session/ses_control/permission/perm_control/reply")
      return new Response(null, { status: 204 })
    return undefined
  }, tmp.path)

  try {
    expect(paths).toContain("/api/command")
    expect(paths).not.toContain("/command")

    permission.set("auto")
    emit({
      directory: "/tmp/zaovra/packages/tui",
      payload: {
        id: "event_permission",
        type: "permission.asked",
        properties: {
          id: "perm_control",
          sessionID: "ses_control",
          permission: "read",
          patterns: ["**"],
          always: ["**"],
          metadata: {},
        },
      },
    } as GlobalEvent)

    await wait(() => paths.includes("/api/session/ses_control/permission/perm_control/reply"))
  } finally {
    app.renderer.destroy()
  }
})
