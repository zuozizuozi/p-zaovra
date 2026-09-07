import type { APIEvent } from "@solidjs/start/server"
import { and, Database, eq, gt, isNull } from "@zaovra-ai/console-core/drizzle/index.js"
import { Identifier } from "@zaovra-ai/console-core/identifier.js"
import { AuthStorageTable } from "@zaovra-ai/console-core/schema/auth-storage.sql.js"
import { KeyTable } from "@zaovra-ai/console-core/schema/key.sql.js"
import { UserTable } from "@zaovra-ai/console-core/schema/user.sql.js"

type ApprovedDevice = { status: "approved"; accountID: string; email: string; clientID: string; userCode?: string }

export async function POST(input: APIEvent) {
  const body = (await input.request.json().catch(() => ({}))) as {
    grant_type?: string
    device_code?: string
    refresh_token?: string
    client_id?: string
  }
  if (body.client_id !== "zaovra-cli") return tokenError("invalid_client", "Unknown desktop client")
  if (body.grant_type === "refresh_token" && body.refresh_token) return refresh(body.refresh_token)
  if (body.grant_type !== "urn:ietf:params:oauth:grant-type:device_code" || !body.device_code)
    return tokenError("invalid_request", "Invalid device authorization request")

  const device = await Database.use((tx) =>
    tx
      .select({ value: AuthStorageTable.value })
      .from(AuthStorageTable)
      .where(and(eq(AuthStorageTable.key, `desktop-device:${body.device_code}`), gt(AuthStorageTable.expiry, new Date())))
      .then((rows) => rows[0]?.value as ApprovedDevice | { status: "pending" } | undefined),
  )
  if (!device) return tokenError("expired_token", "The device code has expired")
  if (device.status !== "approved") return tokenError("authorization_pending", "Waiting for browser approval")
  return issue(device, undefined, body.device_code)
}

async function refresh(refreshToken: string) {
  const approved = await Database.use((tx) =>
    tx
      .select({ value: AuthStorageTable.value })
      .from(AuthStorageTable)
      .where(and(eq(AuthStorageTable.key, `desktop-refresh:${refreshToken}`), gt(AuthStorageTable.expiry, new Date())))
      .then((rows) => rows[0]?.value as ApprovedDevice | undefined),
  )
  if (!approved) return tokenError("invalid_grant", "Refresh token is invalid or expired")
  return issue(approved, refreshToken)
}

async function issue(approved: ApprovedDevice, existingRefreshToken?: string, deviceCode?: string) {
  const membership = await Database.use((tx) =>
    tx
      .select({ userID: UserTable.id, workspaceID: UserTable.workspaceID })
      .from(UserTable)
      .where(and(eq(UserTable.accountID, approved.accountID), isNull(UserTable.timeDeleted)))
      .limit(1)
      .then((rows) => rows[0]),
  )
  if (!membership) return tokenError("access_denied", "No Zaovra workspace is available for this account")

  const accessToken = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")
  const refreshToken = existingRefreshToken ?? crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")
  const value = { ...approved, userID: membership.userID, workspaceID: membership.workspaceID }
  const issued = await Database.transaction(async (tx) => {
    if (deviceCode) {
      const claimed = await tx
        .delete(AuthStorageTable)
        .where(eq(AuthStorageTable.key, `desktop-device:${deviceCode}`))
        .returning({ key: AuthStorageTable.key })
      if (!claimed.length) return false
      if (approved.userCode) {
        await tx.delete(AuthStorageTable).where(eq(AuthStorageTable.key, `desktop-user:${approved.userCode}`))
      }
    }
    await tx.insert(AuthStorageTable).values({
      key: `desktop-access:${accessToken}`,
      value,
      expiry: new Date(Date.now() + 60 * 60 * 1000),
    })
    if (!existingRefreshToken) {
      await tx.insert(AuthStorageTable).values({
        key: `desktop-refresh:${refreshToken}`,
        value: approved,
        expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
    }
    await tx.insert(KeyTable).values({
      id: Identifier.create("key"),
      workspaceID: membership.workspaceID,
      userID: membership.userID,
      name: "Zaovra desktop session",
      key: accessToken,
    })
    return true
  })
  if (!issued) return tokenError("invalid_grant", "The device code has already been used")
  return Response.json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600 })
}

function tokenError(error: string, error_description: string) {
  return Response.json({ error, error_description })
}
