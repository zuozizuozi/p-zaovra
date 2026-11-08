import { describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { prepareReleaseNotes, requireReleaseNotes, versionReleaseNotes } from "./release-notes"

const notes = {
  zh: [{ title: "CI743中文测试", description: "仅隔离夹具，非发行文案", focus: true }],
  en: [{ title: "CI743 English fixture", description: "Test data, not release copy", focus: true }],
}

describe("743 every Beta has exact version release notes", () => {
  test("the same pending copy binds to the actual assigned version without predicting a Beta number", () => {
    for (const version of ["0.1.1-beta.17", "0.1.1-beta.18"]) {
      expect(versionReleaseNotes(version, notes)).toEqual({ version, ...notes })
    }
    expect(requireReleaseNotes(notes)).toEqual(notes)
  })

  test("missing, blank, malformed or unmatched bilingual copy fails closed", () => {
    for (const input of [
      undefined,
      {},
      { zh: [], en: [] },
      { zh: notes.zh, en: [] },
      { zh: notes.zh, en: [{ title: "", description: "x" }] },
      { zh: notes.zh, en: [{ ...notes.en[0], focus: false }] },
      { zh: notes.zh, en: [{ ...notes.en[0], focus: "yes" }] },
    ]) {
      expect(() => requireReleaseNotes(input)).toThrow()
    }
    for (const version of ["", "next", "0.1.1", "0.1.1-beta.0", "0.1.1-beta.17-other"]) {
      expect(() => versionReleaseNotes(version, notes)).toThrow()
    }
  })

  test("preparation writes the assigned version and failed content cannot overwrite it", async () => {
    if (!Bun.env.ZAOVRA_BETA_TEST_DIR) throw new Error("Use an explicit isolated ZAOVRA_BETA_TEST_DIR")
    const folder = path.join(Bun.env.ZAOVRA_BETA_TEST_DIR, "notes743")
    const source = pathToFileURL(path.join(folder, "next.json"))
    const target = pathToFileURL(path.join(folder, "current.json"))
    await Bun.write(source, JSON.stringify(notes))
    await prepareReleaseNotes("0.1.1-beta.17", source, target)
    expect(await Bun.file(target).json()).toEqual({ version: "0.1.1-beta.17", ...notes })
    await prepareReleaseNotes("0.1.1-beta.18", source, target)
    expect(await Bun.file(target).json()).toEqual({ version: "0.1.1-beta.18", ...notes })
    const before = await Bun.file(target).text()
    await Bun.write(source, JSON.stringify({ zh: [], en: [] }))
    await expect(prepareReleaseNotes("0.1.1-beta.19", source, target)).rejects.toThrow("empty")
    expect(await Bun.file(target).text()).toBe(before)
  })

  test("the build gate checks exact source copy and preparation runs before prebuild", async () => {
    const workflow = await Bun.file(new URL("../../../.github/workflows/windows-beta.yml", import.meta.url)).text()
    const gate = workflow.split("\n  build:")[0]
    expect(gate).toContain("Require pending bilingual release notes")
    expect(gate).toContain("if: steps.gate.outputs.build == 'true'")
    expect(gate).toContain('git show "$SOURCE_SHA:packages/app-ui/src/release-notes/next.json"')
    expect(gate).toContain('scripts/release-notes.ts check "$RUNNER_TEMP/release-notes.json"')
    const prepare = await Bun.file(new URL("./prepare.ts", import.meta.url)).text()
    expect(prepare.indexOf("await prepareReleaseNotes(Script.version)")).toBeLessThan(
      prepare.indexOf('await import("./prebuild")'),
    )
  })
})
