import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Database } from "bun:sqlite"

const root = process.env.ZAOVRA_SERVER_TEST_DIR
if (!root || !path.isAbsolute(root)) throw new Error("Use an isolated absolute ZAOVRA_SERVER_TEST_DIR")
for (const [key, directory] of Object.entries({
  HOME: "home",
  USERPROFILE: "home",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state",
  TEMP: "temp",
  TMP: "temp",
  TMPDIR: "temp",
})) {
  process.env[key] = path.join(root, directory)
  await fs.mkdir(process.env[key]!, { recursive: true })
}
process.env.ZAOVRA_TEST_HOME = path.join(root, "home")
process.env.ZAOVRA_DISABLE_MODELS_FETCH = "true"
process.env.ZAOVRA_CONFIG_CONTENT = "{}"
process.env.ZAOVRA_DB = path.join(root, "pages.sqlite")
const { createEmbeddedRoutes } = await import("./routes")
const { Layer } = await import("effect")
const { HttpRouter, HttpServer } = await import("effect/unstable/http")

test("production HTTP retains turn boundaries in both cursors and preserves old message paging", async () => {
  const directory = path.join(root!, "project")
  await fs.mkdir(directory, { recursive: true })
  const web = HttpRouter.toWebHandler(createEmbeddedRoutes().pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  })
  const sessionID = "ses_http_turn_pages"
  const get = (query: Record<string, string>) => {
    const url = new URL(`http://localhost/api/session/${sessionID}/message`)
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value))
    return web.handler(new Request(url))
  }
  try {
    const created = await web.handler(
      new Request("http://localhost/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: sessionID, location: { directory } }),
      }),
    )
    expect(created.status, await created.clone().text()).toBe(200)
    // Imported history uses negative durable sequences. No provider, tools, or runner are involved.
    const db = new Database(process.env.ZAOVRA_DB)
    try {
      const insert = db.query(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, 0, ?)",
      )
      db.transaction(() => {
        Array.from({ length: 360 }, (_, index) => {
          const user = [0, 4, 356].includes(index)
          insert.run(
            `msg_http_${index}`,
            sessionID,
            user ? "user" : "shell",
            index - 360,
            0,
            JSON.stringify(
              user
                ? { text: `user ${index}`, time: { created: 0 } }
                : {
                    callID: `call_${index}`,
                    command: "echo done",
                    output: "done",
                    time: { created: 0 },
                    turn: `msg_http_${index < 4 ? 0 : index < 356 ? 4 : 356}`,
                  },
            ),
          )
        })
      })()
    } finally {
      db.close()
    }

    const old = await (await get({ limit: "2" })).json()
    expect(old.data.map((message: { id: string }) => message.id)).toEqual(["msg_http_359", "msg_http_358"])
    expect(JSON.parse(Buffer.from(old.cursor.next, "base64url").toString()).boundary).toBeUndefined()
    expect((await (await get({ limit: "2", cursor: old.cursor.next })).json()).data).toHaveLength(2)

    for (const order of ["asc", "desc"]) {
      const response = await get({ limit: "2", order, boundary: "turn" })
      expect(response.status).toBe(200)
      const first = await response.json()
      expect(first.data).toHaveLength(4)
      expect(JSON.parse(Buffer.from(first.cursor.next, "base64url").toString()).boundary).toBe("turn")
      const second = await (await get({ limit: "2", cursor: first.cursor.next })).json()
      expect(second.data).toHaveLength(352)
      expect(second.data[order === "asc" ? 0 : 351].id).toBe("msg_http_4")
      expect(second.watermark).toBe(first.watermark)
      expect(second.pending).toEqual([])
      const previous = await (await get({ limit: "2", cursor: second.cursor.previous })).json()
      expect(previous.data).toEqual(first.data)
      const third = await (await get({ limit: "2", cursor: second.cursor.next })).json()
      expect(third.data).toHaveLength(4)
      expect((await (await get({ limit: "2", cursor: third.cursor.next })).json()).data).toEqual([])
      expect((await get({ cursor: first.cursor.next, boundary: "turn" })).status).toBe(400)
      expect((await get({ cursor: first.cursor.next, order })).status).toBe(400)
    }
    expect((await get({ boundary: "shell" })).status).toBe(400)
    expect((await get({ cursor: "malformed" })).status).toBe(400)
    expect((await get({ limit: "201", boundary: "turn" })).status).toBe(400)
    expect(
      (
        await (
          await get({
            cursor: Buffer.from(
              JSON.stringify({ id: "msg_missing", order: "desc", direction: "next", boundary: "turn" }),
            ).toString("base64url"),
          })
        ).json()
      ).data,
    ).toEqual([])
  } finally {
    await web.dispose()
  }
}, 30000)
