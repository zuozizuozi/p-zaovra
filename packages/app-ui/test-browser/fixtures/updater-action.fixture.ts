import { describe, expect, test } from "bun:test"
import { showPackagedUpdater, updaterDetail, updaterAction } from "../../src/components/updater-action"

describe("updaterAction", () => {
  test("disables update actions when the platform has no updater", () => {
    expect(updaterAction(undefined)).toEqual({ label: "settings.updates.action.checkNow" })
  })

  test("projects updater transitions into one settings action", () => {
    expect(updaterAction({ status: "idle" })).toEqual({
      label: "settings.updates.action.checkNow",
      run: "check",
    })
    expect(updaterAction({ status: "checking" })).toEqual({ label: "settings.updates.action.checking" })
    expect(updaterAction({ status: "available", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.download",
      run: "download",
    })
    expect(updaterAction({ status: "downloading", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.downloading",
    })
    expect(updaterAction({ status: "ready", version: "2.0.0" })).toEqual({
      label: "toast.update.action.installRestart",
      run: "install",
    })
    expect(updaterAction({ status: "installing", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.installing",
    })
  })
})

test("612 updater entry is confined to packaged Beta and production", () => {
  for (const channel of ["dev", undefined])
    expect(showPackagedUpdater({ platform: "desktop", channel, updater: {} })).toBe(false)
  for (const channel of ["beta", "prod"]) {
    expect(showPackagedUpdater({ platform: "desktop", channel, updater: {} })).toBe(true)
    expect(showPackagedUpdater({ platform: "desktop", channel })).toBe(false)
    expect(showPackagedUpdater({ platform: "web", channel, updater: {} })).toBe(false)
  }
})
test("612 update progress and failures are actionable", () => {
  expect(updaterDetail({ status: "downloading", version: "1.0", percent: 32.6 })).toBe("33%")
  expect(updaterDetail({ status: "downloading", version: "1.0" })).toBe("")
  expect(updaterDetail({ status: "error", message: "Network unavailable" })).toBe("Network unavailable")
  expect(updaterAction({ status: "error", message: "offline" }).run).toBe("check")
  expect(updaterAction({ status: "up-to-date" }).run).toBe("check")
})
