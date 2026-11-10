import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import path from "node:path"
import { Context } from "effect"
import { Global } from "@zaovra-ai/core/global"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { fingerprint } from "./revert-plan-fingerprint"

// A script keeps the durable database; bun test's preload uses :memory:.
const [database, directory, sessionID, messageID] = process.argv.slice(2)
if (!database || !directory || !sessionID || !messageID) throw new Error("Missing cold-plan fixture arguments")
const dbBefore = rows(database)
const runtimeLog = path.join(Global.Path.log, "zaovra.log")
const treeBefore = await fingerprint([directory, Global.Path.data], runtimeLog)
const databaseBefore = await fingerprint([path.dirname(database)])
const context = Context.empty() as Context.Context<unknown>
const handler = HttpApiApp.webHandler()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => handler.handler(request, context),
})
const response = await coldRequest()
const dbAfter = rows(database)
const treeAfter = await fingerprint([directory, Global.Path.data], runtimeLog)
const databaseAfter = await fingerprint([path.dirname(database)])
console.log(
  "cold-http-plan:" +
    JSON.stringify({
      ...response,
      dbBefore,
      dbAfter,
      treeBefore: treeBefore.hash,
      treeAfter: treeAfter.hash,
      combinedTreeBefore: treeBefore.combinedHash,
      combinedTreeAfter: treeAfter.combinedHash,
      filesBefore: treeBefore.files,
      filesAfter: treeAfter.files,
      databaseFilesBefore: databaseBefore.files,
      databaseFilesAfter: databaseAfter.files,
      pid: process.pid,
    }),
)

async function coldRequest() {
  try {
    // This is the first product request in this process; no Location is warmed.
    const response = await fetch(`http://127.0.0.1:${server.port}/api/session/${sessionID}/revert/plan/${messageID}`, {
      headers: { "x-zaovra-directory": encodeURIComponent(directory) },
      signal: AbortSignal.timeout(30_000),
    })
    return { status: response.status, body: await response.text() }
  } finally {
    await server.stop(true)
    await handler.dispose()
    const { AppRuntime } = await import("../../src/effect/app-runtime")
    await AppRuntime.dispose()
  }
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
