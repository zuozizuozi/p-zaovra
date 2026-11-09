import { test } from "node:test"
import assert from "node:assert/strict"
import { AppUpdater } from "electron-updater/out/AppUpdater.js"

test("780 installed electron-updater accepts Beta.19 to Beta 0.2.0 and refuses downgrade", async () => {
  // Exercise the installed updater's actual version decision without an Electron window or download.
  const old = new AppUpdater(undefined, { version: "0.1.1-beta.19" })
  old.channel = "beta"
  old.allowPrerelease = true
  old.allowDowngrade = false
  assert.equal(await old.isUpdateAvailable({ version: "0.2.0-beta.1" }), true)
  const current = new AppUpdater(undefined, { version: "0.2.0-beta.1" })
  current.channel = "beta"
  current.allowPrerelease = true
  current.allowDowngrade = false
  assert.equal(await current.isUpdateAvailable({ version: "0.1.1-beta.19" }), false)
  assert.equal(await current.isUpdateAvailable({ version: "0.2.0-beta.1" }), false)
  assert.equal(await current.isUpdateAvailable({ version: "0.2.1-beta.1" }), true)
  assert.equal(await current.isUpdateAvailable({ version: "0.2.2-beta.1" }), true)
})
