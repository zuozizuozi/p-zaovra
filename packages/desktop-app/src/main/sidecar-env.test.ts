import { expect, test } from "bun:test"
import { join } from "node:path"
import { createSidecarEnv } from "./sidecar-env"

test("only packaged prod isolates history while preserving shared settings and cache", () => {
  const env = { XDG_DATA_HOME: "shared", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", DEBUG: "*" }
  const input = { env, platform: "win32" as const, userDataPath: "profile", channel: "prod" }
  const prod = createSidecarEnv({ ...input, packaged: true })
  expect(prod.XDG_DATA_HOME).toBe(join("profile", "data"))
  expect(prod.XDG_CONFIG_HOME).toBe("config")
  expect(prod.XDG_CACHE_HOME).toBe("cache")
  expect(prod.DEBUG).toBeUndefined()
  const dev = createSidecarEnv({ ...input, channel: "dev", packaged: false })
  expect(dev.XDG_DATA_HOME).toBe("shared")
  expect(dev.ZAOVRA_DISABLE_CHANNEL_DB).toBe("1")
  expect(createSidecarEnv({ ...input, channel: "beta", packaged: true }).XDG_DATA_HOME).toBe("shared")
  expect(env.XDG_DATA_HOME).toBe("shared")
})
