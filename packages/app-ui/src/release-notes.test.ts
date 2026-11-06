import { describe, expect, test } from "bun:test"
import { releaseNotes, shouldShowReleaseNotes } from "./release-notes"

describe("versioned release notes", () => {
  test("loads only the exact current version with matching bilingual entries", () => {
    const zh = releaseNotes("0.1.1-beta.12", "zh-CN")
    const en = releaseNotes("0.1.1-beta.12", "en")
    expect(zh).toHaveLength(5)
    expect(en).toHaveLength(zh.length)
    expect(zh.map((item) => !!item.focus)).toEqual([true, true, true, false, false])
    expect(en.map((item) => !!item.focus)).toEqual(zh.map((item) => !!item.focus))
    expect([...zh, ...en].every((item) => item.title.trim() && item.description.trim())).toBe(true)
    expect(releaseNotes("0.1.1-beta.11", "zh")).toEqual([])
  })

  test("fresh installs and repeat launches stay quiet", () => {
    expect(shouldShowReleaseNotes(undefined, "0.1.1-beta.12", true, 5)).toBe(false)
    expect(shouldShowReleaseNotes("0.1.1-beta.12", "0.1.1-beta.12", true, 5)).toBe(false)
  })

  test("a changed beta version can display once even with the same semver core", () => {
    expect(shouldShowReleaseNotes("0.1.1-beta.11", "0.1.1-beta.12", true, 5)).toBe(true)
  })

  test("disabled notes, missing versions and missing content stay quiet", () => {
    expect(shouldShowReleaseNotes("0.1.1-beta.11", "0.1.1-beta.12", false, 5)).toBe(false)
    expect(shouldShowReleaseNotes("0.1.1-beta.11", undefined, true, 5)).toBe(false)
    expect(shouldShowReleaseNotes("0.1.1-beta.11", "0.1.1-beta.13", true, 0)).toBe(false)
    expect(releaseNotes("0.1.1-beta.13", "zh")).toEqual([])
    expect(releaseNotes(undefined, "en")).toEqual([])
  })
})
