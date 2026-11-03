import { mkdir, realpath, writeFile } from "node:fs/promises"
import { resolve, join, relative, isAbsolute } from "node:path"
import { createHash } from "node:crypto"

const receipt = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export async function archiveFeedback(input: {
  token: string
  directory: string
  archiveRoot?: string
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
}) {
  if (!input.token.trim() || input.token.length > 16_384 || /\s/.test(input.token.trim()))
    throw new Error("Pipe a single Access token through stdin")
  const allowed = await realpath(input.archiveRoot ?? "F:/Zaovra-研发记录")
  const output = resolve(input.directory)
  if (!inside(allowed, output)) throw new Error("Archive must stay inside F:/Zaovra-研发记录")
  await mkdir(output, { recursive: true })
  if (!inside(allowed, await realpath(output))) throw new Error("Archive path resolves outside the records directory")
  const fetcher = input.fetcher ?? fetch
  const get = async (path: string, limit: number) => {
    const response = await fetcher("https://feedback.zaovra.com/admin/" + path, {
      headers: { "cf-access-token": input.token.trim() },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error("Access or feedback request failed: HTTP " + response.status)
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Missing archive response")
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > limit) throw new Error("Archive response exceeds its limit")
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    return Buffer.concat(chunks)
  }
  const archived: { receipt: string; bytes: number; sha256: string }[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 200; page++) {
    const list = JSON.parse(
      (await get("reports" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""), 65_536)).toString(),
    ) as {
      reports: { receipt: string }[]
      cursor: string | null
    }
    if (
      !Array.isArray(list.reports) ||
      list.reports.length > 50 ||
      (list.cursor !== null && (typeof list.cursor !== "string" || list.cursor.length > 2048))
    )
      throw new Error("Invalid feedback listing")
    for (const report of list.reports) {
      if (!receipt.test(report.receipt)) throw new Error("Invalid feedback receipt")
      const path = join(output, report.receipt + ".json")
      if (await Bun.file(path).exists()) continue
      const bytes = await get("report/" + report.receipt, 5_500_000)
      const body = JSON.parse(bytes.toString()) as { snapshot?: { files?: { name: string; text: string }[] } }
      if (
        JSON.parse(body.snapshot?.files?.find((file) => file.name === "report.json")?.text ?? "{}").reportID !==
        report.receipt
      )
        throw new Error("Report does not match its receipt")
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
      archived.push({
        receipt: report.receipt,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })
    }
    if (!list.cursor) return archived
    if (seen.has(list.cursor)) throw new Error("Repeated archive cursor")
    seen.add(list.cursor)
    cursor = list.cursor
  }
  throw new Error("Archive page limit reached; preserve downloaded originals and continue later")
}

function inside(root: string, path: string) {
  const remainder = relative(root, path)
  return (
    Boolean(remainder) &&
    !isAbsolute(remainder) &&
    remainder !== ".." &&
    !remainder.startsWith("../") &&
    !remainder.startsWith("..\\")
  )
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: pipe Access token to archive-feedback.ts <F-records-directory>")
  const token = (await Bun.stdin.text()).trim()
  await archiveFeedback({ token, directory: process.argv[2] }).then(
    (archived) => console.log(JSON.stringify({ archived }, null, 2)),
    () => {
      console.error(
        "Feedback archive failed. Check Access login and the archive directory; token details are not logged.",
      )
      process.exitCode = 1
    },
  )
}
