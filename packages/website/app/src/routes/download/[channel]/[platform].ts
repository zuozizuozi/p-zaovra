import type { APIEvent } from "@solidjs/start"
import type { DownloadPlatform } from "../types"

export async function GET({ params: { platform, channel } }: APIEvent) {
  if (channel !== "stable" || platform !== ("windows-x64-nsis" satisfies DownloadPlatform))
    return new Response(null, { status: 404 })
  return Response.json(
    { error: "The Windows installer has not been published yet. Contact support@zaovra.com for release status." },
    { status: 503 },
  )
}
