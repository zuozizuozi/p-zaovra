export * as MemoryFileEvidence from "./file-evidence"

import path from "node:path"
import { Option, Schema } from "effect"
import { Memory } from "@zaovra-ai/schema/memory"

/** Internal host boundary, NOT proof of permission or a completed production receipt. */
export interface Bind {
  readonly id: Memory.ID
  readonly scope: Memory.Scope
  readonly expectedRevision: number
  readonly files: ReadonlyArray<Memory.FileBinding>
}
export interface Check {
  readonly id: Memory.ID
  readonly scope: Memory.Scope
  readonly expectedRevision: number
  readonly results: ReadonlyArray<{
    readonly path: string
    readonly state: "unchanged" | "changed" | "missing" | "unknown"
  }>
}

export const decode = Schema.decodeUnknownOption(Memory.FileLinks)

export function bindings(files: Bind["files"]) {
  const parsed = decode({ version: 1, files, state: "unknown" })
  if (Option.isNone(parsed)) return
  if (new Set(files.map((file) => file.path)).size !== files.length) return
  // These are logical root-relative names only. Never resolve or read them here.
  if (
    files.some(
      (file) =>
        file.path.includes("\\") ||
        file.path.includes(":") ||
        file.path.includes("\0") ||
        file.path.split("/").some((part) => !part || part === "." || part === ".."),
    )
  )
    return
  if (new Set(files.map((file) => file.directory)).size !== 1) return
  return parsed.value
}

export function compare(value: unknown, results: Check["results"]): Memory.FileLinks | undefined {
  const parsed = decode(value)
  if (Option.isNone(parsed)) return
  const previous = parsed.value
  if (results.length !== previous.files.length || new Set(results.map((item) => item.path)).size !== results.length)
    return
  if (results.some((item) => !previous.files.some((file) => file.path === item.path))) return
  if (results.some((item) => !["unchanged", "changed", "missing", "unknown"].includes(item.state))) return
  const state =
    previous.state === "changed" || previous.state === "missing"
      ? previous.state
      : results.some((item) => item.state === "changed")
        ? "changed"
        : results.some((item) => item.state === "missing")
          ? "missing"
          : results.some((item) => item.state === "unknown")
            ? "unknown"
            : "current"
  return { ...previous, state, checkedAt: Date.now() }
}

/** L2/context may use this only for eligibility, never to authorize a file read. */
export function usable(note: Memory.Note) {
  return state(note) === "untracked" || state(note) === "current"
}

export function state(note: Memory.Note) {
  if (note.files === undefined) return "untracked" as const
  const parsed = decode(note.files)
  return Option.isSome(parsed) ? parsed.value.state : ("unknown" as const)
}

/** A wording edit invalidates a formerly current association, not an existing alert. */
export function edited(value: unknown) {
  const parsed = decode(value)
  if (Option.isNone(parsed) || parsed.value.state !== "current") return value
  return { ...parsed.value, state: "unknown" as const }
}

/** No process has a complete monitoring/positive recheck contract yet. DB current is not authority. */
export function untrusted(value: unknown) {
  const parsed = decode(value)
  if (Option.isNone(parsed) || parsed.value.state !== "current") return value
  return { version: parsed.value.version, files: parsed.value.files, state: "unknown" as const }
}

/** Lexical identity only; watcher hints never stat, resolve symlinks or read protected content. */
export function affected(
  links: Memory.FileLinks,
  input: { readonly directory: string; readonly path?: string },
  platform: NodeJS.Platform = process.platform,
) {
  if (!bindings(links.files)) return false
  const paths = platform === "win32" ? path.win32 : path.posix
  const normalize = (value: string) =>
    platform === "win32" ? paths.normalize(value).toLowerCase() : paths.normalize(value)
  if (!paths.isAbsolute(input.directory) || (input.path !== undefined && !paths.isAbsolute(input.path))) return false
  return links.files.some((file) => {
    if (normalize(file.directory) !== normalize(input.directory)) return false
    if (input.path === undefined) return true
    const relative = paths.relative(normalize(input.path), normalize(paths.join(file.directory, file.path)))
    return (
      relative === "" || (!relative.startsWith(`..${paths.sep}`) && relative !== ".." && !paths.isAbsolute(relative))
    )
  })
}
