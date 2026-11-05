import { expect, test } from "bun:test"
import { join } from "node:path"
import { createSidecarEnv, sidecarDirectory } from "../src/main/sidecar-env"
import { completeFirstLaunch } from "../src/main/onboarding-directory"

test.each(["prod", "beta", "dev"])(
  "%s sidecar roots cannot inherit another channel's database or config",
  (channel) => {
    const inherited = {
      XDG_DATA_HOME: "shared-data",
      XDG_CONFIG_HOME: "shared-config",
      XDG_STATE_HOME: "shared-state",
      XDG_CACHE_HOME: "shared-cache",
      ZAOVRA_DB: "shared.db",
      ZAOVRA_CONFIG_DIR: "shared-config-dir",
      ZAOVRA_CONFIG_CONTENT: '{"provider":{"private":{}}}',
      ZAOVRA_CONFIG: "shared.json",
    }
    const env = createSidecarEnv({
      env: inherited,
      platform: "win32",
      packaged: true,
      channel,
      userDataPath: join("profiles", channel),
    })
    for (const [key, dir] of [
      ["XDG_DATA_HOME", "data"],
      ["XDG_CONFIG_HOME", "config"],
      ["XDG_STATE_HOME", "state"],
      ["XDG_CACHE_HOME", "cache"],
    ])
      expect(env[key]).toBe(join("profiles", channel, "backend", dir))
    for (const key of ["ZAOVRA_DB", "ZAOVRA_CONFIG_DIR", "ZAOVRA_CONFIG", "ZAOVRA_CONFIG_CONTENT"])
      expect(env[key]).toBeUndefined()
    expect(inherited.ZAOVRA_DB).toBe("shared.db")
    expect(sidecarDirectory(join("profiles", channel))).toBe(join("profiles", channel, "backend", "config", "zaovra"))
  },
)

test("existing profile does not create a default directory", async () => {
  const result = await completeFirstLaunch({
    pending: false,
    create: true,
    path: () => {
      throw new Error("unexpected path lookup")
    },
    mkdir: async () => {
      throw new Error("unexpected directory creation")
    },
    complete: () => {
      throw new Error("unexpected completion")
    },
  })
  expect(result).toBe(null)
})
