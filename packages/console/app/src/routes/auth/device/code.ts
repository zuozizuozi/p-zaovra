import type { APIEvent } from "@solidjs/start/server"
import { Database } from "@zaovra-ai/console-core/drizzle/index.js"
import { AuthStorageTable } from "@zaovra-ai/console-core/schema/auth-storage.sql.js"

export async function POST(input: APIEvent) {
  const body = (await input.request.json().catch(() => ({}))) as { client_id?: string }
  if (body.client_id !== "zaovra-cli") return Response.json({ error: "invalid_client" }, { status: 400 })

  const deviceCode = crypto.randomUUID().replaceAll("-", "")
  const userCode = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()
  const expiresIn = 600
  await Database.transaction(async (tx) => {
    const expiry = new Date(Date.now() + expiresIn * 1000)
    await tx.insert(AuthStorageTable).values([
      {
        key: `desktop-device:${deviceCode}`,
        value: { status: "pending", clientID: body.client_id, userCode },
        expiry,
      },
      {
        key: `desktop-user:${userCode}`,
        value: { deviceCode },
        expiry,
      },
    ])
  })

  return Response.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri_complete: `/device?user_code=${userCode}`,
    expires_in: expiresIn,
    interval: 5,
  })
}
