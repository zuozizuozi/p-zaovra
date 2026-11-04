import { expect, test } from "bun:test"
import { wslBackendEnvironment } from "./environment"

test("WSL sidecars separate both channel and explicit Electron profile without shell interpolation of Windows paths", () => {
  const dev = wslBackendEnvironment("dev", "profile-a")
  const beta = wslBackendEnvironment("beta", "profile-a")
  const other = wslBackendEnvironment("beta", "profile-$(untrusted)")
  expect(dev[0]).not.toBe(beta[0])
  expect(beta[0]).not.toBe(other[0])
  expect(other.join("\n")).not.toContain("$(untrusted)")
  expect(beta).toContain("unset ZAOVRA_DB ZAOVRA_CONFIG ZAOVRA_CONFIG_DIR ZAOVRA_CONFIG_CONTENT")
  expect(beta).toContain("export ZAOVRA_DISABLE_CHANNEL_DB=1")
})
