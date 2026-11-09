import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createServer } from "node:http"
import { pathToFileURL } from "node:url"
import { prepareReleaseNotes, previousReleaseCommit, requireReleaseNotes, versionReleaseNotes } from "./release-notes"

const notes = {
  zh: [{ title: "CI743中文测试", description: "仅隔离夹具，非发行文案" }],
  en: [{ title: "CI743 English fixture", description: "Test data, not release copy" }],
}

describe("743 every Beta has exact version release notes", () => {
  test("750 rejects the same published copy despite focus or whitespace changes", () => {
    expect(() => requireReleaseNotes(notes, notes)).toThrow("previous published release")
    expect(() =>
      requireReleaseNotes(
        { ...notes, zh: notes.zh.map((item) => ({ ...item, title: "  " + item.title + "  ", focus: false })) },
        notes,
      ),
    ).toThrow("previous published release")
  })

  test("the same pending copy binds to the actual assigned version without predicting a Beta number", () => {
    for (const version of ["0.1.1-beta.17", "0.1.1-beta.18", "0.2.0-beta.1", "0.2.1-beta.1", "0.2.2-beta.1"]) {
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
      { zh: notes.zh, en: [{ ...notes.en[0], title: 42 }] },
      { zh: notes.zh, en: [{ ...notes.en[0], description: null }] },
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
    await prepareReleaseNotes("0.2.0-beta.1", source, target)
    expect(await Bun.file(target).json()).toEqual({ version: "0.2.0-beta.1", ...notes })
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
    expect(gate).toContain(
      'scripts/release-notes.ts check "$RUNNER_TEMP/release-notes.json" "$RUNNER_TEMP/previous-release-notes.json"',
    )
    expect(gate).toContain("scripts/release-notes.ts previous")
    expect(gate).toContain('git merge-base --is-ancestor "$PREVIOUS_SHA" "$SOURCE_SHA"')
    expect(gate).toContain('git show "$PREVIOUS_SHA:packages/app-ui/src/release-notes/next.json"')
    const prepare = await Bun.file(new URL("./prepare.ts", import.meta.url)).text()
    expect(prepare.indexOf("await prepareReleaseNotes(Script.version)")).toBeLessThan(
      prepare.indexOf('await import("./prebuild")'),
    )
  })
  test("750 rejects reorder-only copy, accepts real edits, and validates the comparison", () => {
    const previous = {
      zh: [...notes.zh, { title: "第二条", description: "旧说明" }],
      en: [...notes.en, { title: "Second", description: "Old details" }],
    }
    expect(() =>
      requireReleaseNotes({ zh: [...previous.zh].reverse(), en: [...previous.en].reverse() }, previous),
    ).toThrow("previous published release")
    expect(
      requireReleaseNotes({ ...notes, zh: [{ ...notes.zh[0], description: "新的说明" }] }, notes).zh[0].description,
    ).toBe("新的说明")
    expect(() => requireReleaseNotes(notes, { zh: [], en: [] })).toThrow("empty")
  })

  test("750 reads the actual published manifest and rejects missing or mismatched identities", async () => {
    const state = {
      pointer: "version: 0.1.1-beta.17\n",
      status: 200,
      manifest: { version: "0.1.1-beta.17", commit: "9".repeat(40) },
    }
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? "")
      if (request.url === "/beta/beta.yml") {
        response.writeHead(state.status).end(state.pointer)
        return
      }
      response.writeHead(state.status, { "content-type": "application/json" }).end(JSON.stringify(state.manifest))
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing local fixture address")
    const base = "http://127.0.0.1:" + address.port + "/"
    try {
      expect(await previousReleaseCommit(base)).toBe(state.manifest.commit)
      expect(requests).toEqual(["/beta/beta.yml", "/beta/0.1.1-beta.17/release.json"])
      state.manifest.version = "0.1.1-beta.16"
      await expect(previousReleaseCommit(base)).rejects.toThrow("identity")
      state.manifest.version = "0.1.1-beta.17"
      state.manifest.commit = "invalid"
      await expect(previousReleaseCommit(base)).rejects.toThrow("identity")
      state.pointer = "version: ../../other\n"
      await expect(previousReleaseCommit(base)).rejects.toThrow("version")
      state.status = 404
      await expect(previousReleaseCommit(base)).rejects.toThrow("pointer")
    } finally {
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())))
    }
  })
})
