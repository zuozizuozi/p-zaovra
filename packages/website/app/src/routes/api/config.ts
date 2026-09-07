import type { APIEvent } from "@solidjs/start/server"
import { and, Database, eq, isNull } from "@zaovra-ai/console-core/drizzle/index.js"
import { UserTable } from "@zaovra-ai/console-core/schema/user.sql.js"
import { ZenData } from "@zaovra-ai/console-core/model.js"
import { desktopToken, unauthorized } from "./account-auth"

export async function GET(input: APIEvent) {
  const token = await desktopToken(input.request)
  if (!token) return unauthorized()
  const orgID = input.request.headers.get("x-org-id") ?? token.workspaceID
  const membership = await Database.use((tx) =>
    tx
      .select({ id: UserTable.id })
      .from(UserTable)
      .where(and(eq(UserTable.accountID, token.accountID), eq(UserTable.workspaceID, orgID), isNull(UserTable.timeDeleted)))
      .then((rows) => rows[0]),
  )
  if (!membership) return unauthorized()
  const models = ZenData.list("full").models
  return Response.json({
    config: {
      provider: {
        zaovra: {
          name: "Zaovra managed models",
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `${new URL(input.request.url).origin}/zen/v1`,
            apiKey: "{env:ZAOVRA_CONSOLE_TOKEN}",
          },
          models: Object.fromEntries(
            Object.entries(models).map(([id, value]) => {
              const model = Array.isArray(value) ? value[0] : value
              return [id, { name: model.name, cost: { input: model.cost.input, output: model.cost.output } }]
            }),
          ),
        },
      },
    },
  })
}
