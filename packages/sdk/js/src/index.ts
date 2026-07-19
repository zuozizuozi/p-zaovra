export * from "./client.js"
export * from "./server.js"

import { createZaovraClient } from "./client.js"
import { createZaovraServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createZaovra(options?: ServerOptions) {
  const server = await createZaovraServer({
    ...options,
  })

  const client = createZaovraClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
