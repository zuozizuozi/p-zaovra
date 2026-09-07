import type { APIEvent } from "@solidjs/start/server"
import { desktopToken, unauthorized } from "./account-auth"

export async function GET(input: APIEvent) {
  const token = await desktopToken(input.request)
  if (!token) return unauthorized()
  return Response.json({ id: token.accountID, email: token.email })
}
