import type { APIEvent } from "@solidjs/start/server"
import { createAuthIssuer } from "@zaovra-ai/console-function/auth"
import { and, Database, eq, gt, isNull, or, sql } from "@zaovra-ai/console-core/drizzle/index.js"
import { AuthStorageTable } from "@zaovra-ai/console-core/schema/auth-storage.sql.js"
import { Hono } from "hono"

const separator = String.fromCharCode(0x1f)

export function authIssuer(input: APIEvent) {
  const issuer = createAuthIssuer({
    async get(key) {
      const row = await Database.use((tx) =>
        tx
          .select({ value: AuthStorageTable.value, expiry: AuthStorageTable.expiry })
          .from(AuthStorageTable)
          .where(eq(AuthStorageTable.key, key.join(separator)))
          .then((rows) => rows[0]),
      )
      if (!row) return
      if (!row.expiry || row.expiry > new Date()) return row.value as Record<string, unknown>
      await Database.use((tx) => tx.delete(AuthStorageTable).where(eq(AuthStorageTable.key, key.join(separator))))
    },
    async set(key, value, expiry) {
      await Database.use((tx) =>
        tx
          .insert(AuthStorageTable)
          .values({ key: key.join(separator), value, expiry })
          .onConflictDoUpdate({
            target: AuthStorageTable.key,
            set: { value, expiry },
          }),
      )
    },
    async remove(key) {
      await Database.use((tx) => tx.delete(AuthStorageTable).where(eq(AuthStorageTable.key, key.join(separator))))
    },
    async *scan(prefix) {
      const joined = [...prefix, ""].join(separator)
      const rows = await Database.use((tx) =>
        tx
          .select({ key: AuthStorageTable.key, value: AuthStorageTable.value })
          .from(AuthStorageTable)
          .where(
            and(
              sql`left(${AuthStorageTable.key}, ${joined.length}) = ${joined}`,
              or(isNull(AuthStorageTable.expiry), gt(AuthStorageTable.expiry, new Date())),
            ),
          ),
      )
      for (const row of rows) yield [row.key.split(separator), row.value]
    },
  })
  return new Hono().route("/issuer", issuer).fetch(input.request)
}

export function authProviderAuthorize(input: APIEvent) {
  const url = new URL(input.request.url)
  url.pathname = `/issuer${url.pathname}`
  return Response.redirect(url, 302)
}
