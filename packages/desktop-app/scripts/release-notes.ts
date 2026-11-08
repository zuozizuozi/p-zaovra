#!/usr/bin/env bun
import { YAML } from "bun"

export function requireReleaseNotes(input: unknown, previous?: unknown) {
  if (!input || typeof input !== "object" || !("zh" in input) || !("en" in input))
    throw new Error("Pending release notes must contain zh and en entries")
  const zh = requireHighlights(input.zh)
  const en = requireHighlights(input.en)
  if (zh.length !== en.length) throw new Error("Pending release notes must have matching bilingual entries")
  const notes = { zh, en }
  if (previous !== undefined) {
    const published = requireReleaseNotes(previous)
    const content = (items: typeof zh) =>
      items
        .map((item) =>
          [item.title, item.description].map((text) => text.normalize("NFKC").trim().replace(/\s+/gu, " ")).join("\n"),
        )
        .sort()
    if (JSON.stringify([content(zh), content(en)]) === JSON.stringify([content(published.zh), content(published.en)]))
      throw new Error("Pending release notes match the previous published release")
  }
  return notes
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

export async function previousReleaseCommit(base = "https://updates.zaovra.com/") {
  const pointer = await fetch(base + "beta/beta.yml", {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  })
  if (!pointer.ok) throw new Error("Cannot read previous published Beta pointer")
  const metadata: unknown = YAML.parse(await pointer.text())
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("version" in metadata) ||
    typeof metadata.version !== "string" ||
    !/^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(metadata.version)
  )
    throw new Error("Invalid previous published Beta version")
  const response = await fetch(base + "beta/" + metadata.version + "/release.json", {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error("Cannot read previous published Beta identity")
  const release: unknown = await response.json()
  if (
    !release ||
    typeof release !== "object" ||
    !("version" in release) ||
    release.version !== metadata.version ||
    !("commit" in release) ||
    typeof release.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(release.commit)
  )
    throw new Error("Invalid previous published Beta identity")
  return release.commit
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
      !item.description.trim()
    )
      throw new Error("Every release highlight needs a title and description")
    return { title: item.title, description: item.description }
  })
}

if (import.meta.main) {
  if (Bun.argv[2] === "previous") {
    console.log(await previousReleaseCommit())
  }
  if (Bun.argv[2] !== "previous") {
    if (Bun.argv[2] !== "check")
      throw new Error("Usage: bun scripts/release-notes.ts check [pending-json] [previous-json] | previous")
    requireReleaseNotes(
      await Bun.file(Bun.argv[3] ?? new URL("../../app-ui/src/release-notes/next.json", import.meta.url)).json(),
      Bun.argv[4] ? await Bun.file(Bun.argv[4]).json() : undefined,
    )
    console.log("Pending bilingual release notes are ready")
  }
}
