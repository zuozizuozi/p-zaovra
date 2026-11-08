#!/usr/bin/env bun

export function requireReleaseNotes(input: unknown) {
  if (!input || typeof input !== "object" || !("zh" in input) || !("en" in input))
    throw new Error("Pending release notes must contain zh and en entries")
  const zh = requireHighlights(input.zh)
  const en = requireHighlights(input.en)
  if (zh.length !== en.length || zh.some((item, i) => !!item.focus !== !!en[i].focus))
    throw new Error("Pending release notes must have matching bilingual entries and focus flags")
  return { zh, en }
}

export function versionReleaseNotes(version: string, input: unknown) {
  if (!/^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(version))
    throw new Error("Release notes require the actual CI Beta version")
  return { version, ...requireReleaseNotes(input) }
}

export async function prepareReleaseNotes(
  version: string,
  source = new URL("../../app-ui/src/release-notes/next.json", import.meta.url),
  target = new URL("../../app-ui/src/release-notes/current.json", import.meta.url),
) {
  const notes = versionReleaseNotes(version, await Bun.file(source).json())
  await Bun.write(target, JSON.stringify(notes, null, 2) + "\n")
  return notes
}

function requireHighlights(input: unknown) {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Pending release notes cannot be empty")
  return input.map((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("title" in item) ||
      !("description" in item) ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      typeof item.description !== "string" ||
      !item.description.trim() ||
      ("focus" in item && typeof item.focus !== "boolean")
    )
      throw new Error("Every release highlight needs a title and description, with an optional boolean focus")
    return {
      title: item.title,
      description: item.description,
      ...("focus" in item ? { focus: item.focus as boolean } : {}),
    }
  })
}

if (import.meta.main) {
  if (Bun.argv[2] !== "check") throw new Error("Usage: bun scripts/release-notes.ts check [pending-json]")
  requireReleaseNotes(
    await Bun.file(Bun.argv[3] ?? new URL("../../app-ui/src/release-notes/next.json", import.meta.url)).json(),
  )
  console.log("Pending bilingual release notes are ready")
}
