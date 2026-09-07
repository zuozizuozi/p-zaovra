import { and, Database, eq, gt } from "@zaovra-ai/console-core/drizzle/index.js"
import { AuthStorageTable } from "@zaovra-ai/console-core/schema/auth-storage.sql.js"

export type DesktopToken = {
  accountID: string
  email: string
  userID: string
  workspaceID: string
}

export async function desktopToken(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  if (!token) return
  return Database.use((tx) =>
    tx
      .select({ value: AuthStorageTable.value })
      .from(AuthStorageTable)
      .where(and(eq(AuthStorageTable.key, `desktop-access:${token}`), gt(AuthStorageTable.expiry, new Date())))
      .then((rows) => rows[0]?.value as DesktopToken | undefined),
  )
}

export function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 })
}
