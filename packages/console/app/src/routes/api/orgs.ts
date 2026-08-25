import type { APIEvent } from "@solidjs/start/server"
import { and, Database, eq, isNull } from "@zaovra-ai/console-core/drizzle/index.js"
import { UserTable } from "@zaovra-ai/console-core/schema/user.sql.js"
import { WorkspaceTable } from "@zaovra-ai/console-core/schema/workspace.sql.js"
import { desktopToken, unauthorized } from "./account-auth"

export async function GET(input: APIEvent) {
  const token = await desktopToken(input.request)
  if (!token) return unauthorized()
  const orgs = await Database.use((tx) =>
    tx
      .select({ id: WorkspaceTable.id, name: WorkspaceTable.name })
      .from(UserTable)
      .innerJoin(WorkspaceTable, eq(WorkspaceTable.id, UserTable.workspaceID))
      .where(and(eq(UserTable.accountID, token.accountID), isNull(UserTable.timeDeleted), isNull(WorkspaceTable.timeDeleted))),
  )
  return Response.json(orgs)
}
