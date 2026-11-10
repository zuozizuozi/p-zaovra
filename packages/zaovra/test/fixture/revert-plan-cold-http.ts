import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Context } from "effect"
import { Global } from "@zaovra-ai/core/global"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

// A script keeps the durable database; bun test's preload uses :memory:.
const [database, directory, sessionID, messageID] = process.argv.slice(2)
if (!database || !directory || !sessionID || !messageID) throw new Error("Missing cold-plan fixture arguments")
const dbBefore = rows(database)
const treeBefore = await fingerprint([directory, Global.Path.data])
const context = Context.empty() as Context.Context<unknown>
const handler = HttpApiApp.webHandler()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => handler.handler(request, context),
})
try {
  // This is the first product request in this process; no Location is warmed.
  const response = await fetch(`http://127.0.0.1:${server.port}/api/session/${sessionID}/revert/plan/${messageID}`, {
    headers: { "x-zaovra-directory": encodeURIComponent(directory) },
    signal: AbortSignal.timeout(30_000),
  })
  console.log(
    "cold-http-plan:" +
      JSON.stringify({
        status: response.status,
        body: await response.text(),
        dbBefore,
        dbAfter: rows(database),
        treeBefore,
        treeAfter: await fingerprint([directory, Global.Path.data]),
      }),
  )
} finally {
  await server.stop(true)
  await handler.dispose()
}

function rows(filename: string) {
  using db = new Database(filename, { readonly: true })
  return createHash("sha256")
    .update(
      JSON.stringify(
        db
          .query<{ name: string; sql: string }, []>(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all()
          .map((table) => ({
            ...table,
            rows: db
              .query(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`)
              .all()
              .map((row) => JSON.stringify(row))
              .sort(),
          })),
      ),
    )
    .digest("hex")
}

async function fingerprint(roots: string[]) {
  const files: string[] = []
  const visit = async (directory: string) => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(filename)
      if (entry.isFile())
        files.push(
          filename +
            ":" +
            createHash("sha256")
              .update(await fs.readFile(filename))
              .digest("hex"),
        )
      if (entry.isSymbolicLink()) files.push(filename + ":link:" + (await fs.readlink(filename)))
    }
  }
  for (const root of roots) await visit(root)
  return createHash("sha256").update(JSON.stringify(files)).digest("hex")
}
