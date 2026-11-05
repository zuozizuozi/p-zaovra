import { mkdir, realpath, writeFile, readFile, readdir, lstat, rename, rmdir } from "node:fs/promises"
import { resolve, join, relative, isAbsolute, sep } from "node:path"
import { createHash } from "node:crypto"
import { feedbackMetadata, feedbackReceipt } from "../src/metadata"

type Archived = ReturnType<typeof feedbackMetadata> & { path: string; bytes: number; sha256: string; status: string }

export async function archiveFeedback(input: {
  token?: string
  serviceToken?: { clientId: string; clientSecret: string }
  directory: string
  archiveRoot?: string
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
}) {
  const headers = accessHeaders(input)
  const allowed = await realpath(input.archiveRoot ?? "F:/Zaovra-研发记录")
  const output = resolve(input.directory)
  await archiveDirectory(allowed, output)
  const lock = join(output, ".archive.lock")
  await mkdir(lock)
  try {
    const issues = new Map<string, { receipt: string; reason: string }>()
    const known = await archivedRecords(allowed, output, issues)
    const deadline = Date.now() + 240_000
    const fetcher = input.fetcher ?? fetch
    const get = async (path: string, limit: number) => {
      const response = await fetcher("https://feedback.zaovra.com/admin/" + path, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
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
    try {
      for (let page = 0; page < 200; page++) {
        if (Date.now() >= deadline) return archived
        const list: unknown = JSON.parse(
          (await get("reports" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""), 65_536)).toString("utf8"),
        )
        if (
          !list ||
          typeof list !== "object" ||
          !("reports" in list) ||
          !Array.isArray(list.reports) ||
          list.reports.length > 50 ||
          !("cursor" in list) ||
          (list.cursor !== null && (typeof list.cursor !== "string" || list.cursor.length > 2048))
        )
          throw new Error("Invalid feedback listing")
        for (const [position, report] of (list.reports as unknown[]).entries()) {
          if (
            !report ||
            typeof report !== "object" ||
            !("receipt" in report) ||
            typeof report.receipt !== "string" ||
            !feedbackReceipt.test(report.receipt)
          ) {
            const receipt = "page-" + page + "-entry-" + position
            issues.set(receipt, { receipt, reason: "无效编号，未下载或执行" })
            continue
          }
          const receipt = report.receipt
          if (known.has(receipt) || issues.has(receipt)) continue
          if (Date.now() >= deadline || archived.length >= 100) return archived
          let bytes: Buffer | undefined
          try {
            bytes = await get("report/" + receipt, 5_500_000)
            const metadata = feedbackMetadata(
              receipt,
              JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
            )
            const folder = join(output, metadata.received.slice(0, 10).replaceAll("-", ""), receipt)
            await archiveDirectory(allowed, folder)
            const path = join(folder, "feedback.json")
            await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
            const entry = {
              ...metadata,
              path,
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              status: "待处理",
            }
            known.set(receipt, entry)
            await writeFile(
              join(folder, "metadata.json"),
              JSON.stringify({ ...entry, path: "feedback.json", untrusted: true }, null, 2),
              { flag: "wx", mode: 0o600 },
            )
            archived.push({ receipt: receipt, bytes: bytes.length, sha256: entry.sha256 })
          } catch {
            known.delete(receipt)
            // One bad record cannot suppress later receipts. Keep raw errors/text out of the index.
            issues.set(receipt, { receipt: receipt, reason: "记录读取或校验异常，原件保留待人工处理" })
            if (bytes)
              await quarantineRecord(allowed, output, receipt, bytes).catch(() => {
                issues.set(receipt, { receipt: receipt, reason: "隔离保存失败，未覆盖原件；后续记录继续" })
              })
          }
        }
        if (!list.cursor) return archived
        if (seen.has(list.cursor)) throw new Error("Repeated archive cursor")
        seen.add(list.cursor)
        cursor = list.cursor
      }
      throw new Error("Archive page limit reached; preserve originals and continue later")
    } finally {
      await writeArchiveIndex(output, known, issues)
    }
  } finally {
    await rmdir(lock)
  }
}

async function quarantineRecord(root: string, output: string, receipt: string, bytes: Buffer) {
  const folder = join(output, "异常", receipt)
  await archiveDirectory(root, folder)
  const path = join(folder, "feedback.json")
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  if (!existing) await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
}

function accessHeaders(input: { token?: string; serviceToken?: { clientId: string; clientSecret: string } }) {
  const valid = (value: string) => Boolean(value) && value.length <= 16_384 && !/\s/.test(value)
  if (input.serviceToken) {
    if (input.token || !valid(input.serviceToken.clientId) || !valid(input.serviceToken.clientSecret))
      throw new Error("Provide only one complete Access Service Token pair through stdin")
    return new Headers({
      "CF-Access-Client-Id": input.serviceToken.clientId,
      "CF-Access-Client-Secret": input.serviceToken.clientSecret,
    })
  }
  if (!input.token || !valid(input.token.trim())) throw new Error("Pipe a single Access token through stdin")
  return new Headers({ "cf-access-token": input.token.trim() })
}

async function archiveDirectory(root: string, path: string) {
  if (!inside(root, path)) throw new Error("Archive must stay inside F:/Zaovra-研发记录")
  let current = root
  for (const component of relative(root, path).split(sep)) {
    current = join(current, component)
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    if (!existing) await mkdir(current)
    if (!inside(root, await realpath(current))) throw new Error("Archive path resolves outside the records directory")
  }
}

async function archivedRecords(root: string, output: string, issues: Map<string, { receipt: string; reason: string }>) {
  const known = new Map<string, Archived>()
  const quarantine = join(output, "异常")
  await archiveDirectory(root, quarantine)
  for (const entry of await readdir(quarantine, { withFileTypes: true })) {
    if (feedbackReceipt.test(entry.name))
      issues.set(entry.name, { receipt: entry.name, reason: "已隔离异常原件，未重新下载，待人工处理" })
  }
  const retain = async (path: string, receipt: string, date?: string) => {
    if (issues.has(receipt)) return
    try {
      const record = await storedRecord(path, receipt)
      if (date && record.received.slice(0, 10).replaceAll("-", "") !== date)
        throw new Error("Archive date does not match original")
      const statusPath = join(path, "..", "状态.json")
      const statusFile = date
        ? await lstat(statusPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
            return undefined
          })
        : undefined
      if (statusFile) {
        if (!statusFile.isFile() || statusFile.isSymbolicLink() || statusFile.size > 4096)
          throw new Error("Unsafe local status file")
        const status: unknown = JSON.parse(await readFile(statusPath, "utf8"))
        if (
          status &&
          typeof status === "object" &&
          "status" in status &&
          ["待处理", "处理中", "已处理", "已挂账"].includes(String(status.status))
        )
          record.status = String(status.status)
      }
      if (known.has(receipt)) throw new Error("Duplicate local feedback receipt")
      known.set(receipt, record)
    } catch {
      issues.set(receipt, { receipt, reason: "本地原件或元数据异常，未覆盖或重新下载" })
    }
  }
  for (const entry of await readdir(output, { withFileTypes: true })) {
    if (entry.isFile() && feedbackReceipt.test(entry.name.slice(0, -5)) && entry.name.endsWith(".json"))
      await retain(join(output, entry.name), entry.name.slice(0, -5))
    if (!/^\d{8}$/.test(entry.name)) continue
    const date = join(output, entry.name)
    await archiveDirectory(root, date)
    for (const item of await readdir(date, { withFileTypes: true })) {
      if (!feedbackReceipt.test(item.name)) continue
      const folder = join(date, item.name)
      await archiveDirectory(root, folder)
      const original = join(folder, "feedback.json")
      const exists = await lstat(original).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return undefined
      })
      if (exists) await retain(original, item.name, entry.name)
    }
  }
  return known
}

async function storedRecord(path: string, receipt: string): Promise<Archived> {
  const file = await lstat(path)
  if (!file.isFile() || file.isSymbolicLink() || file.size > 5_500_000)
    throw new Error("Unsafe local feedback original")
  const metadataPath = join(path, "..", "metadata.json")
  const metadataFile = path.endsWith(sep + "feedback.json")
    ? await lstat(metadataPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return undefined
      })
    : undefined
  if (metadataFile) {
    if (!metadataFile.isFile() || metadataFile.isSymbolicLink() || metadataFile.size > 16_384)
      throw new Error("Unsafe local archive metadata")
    const cached: unknown = JSON.parse(await readFile(metadataPath, "utf8"))
    if (
      !cached ||
      typeof cached !== "object" ||
      !("receipt" in cached) ||
      cached.receipt !== receipt ||
      !("bytes" in cached) ||
      cached.bytes !== file.size ||
      !("sha256" in cached) ||
      typeof cached.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(cached.sha256) ||
      !("received" in cached) ||
      !("summary" in cached) ||
      typeof cached.summary !== "string" ||
      !("version" in cached) ||
      !("channel" in cached)
    )
      throw new Error("Invalid local archive metadata")
    const record = feedbackMetadata(receipt, {
      received: cached.received,
      snapshot: {
        text: JSON.stringify({
          reportID: receipt,
          description: cached.summary,
          environment: { version: cached.version, channel: cached.channel },
        }),
      },
    })
    return { ...record, path, bytes: file.size, sha256: cached.sha256, status: "待处理" }
  }
  const bytes = await readFile(path)
  const record = {
    ...feedbackMetadata(receipt, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    status: "待处理",
  }
  if (path.endsWith(sep + "feedback.json"))
    await writeFile(metadataPath, JSON.stringify({ ...record, path: "feedback.json", untrusted: true }, null, 2), {
      flag: "wx",
      mode: 0o600,
    })
  return record
}

async function writeArchiveIndex(
  output: string,
  known: Map<string, Archived>,
  issues: Map<string, { receipt: string; reason: string }>,
) {
  const cell = (value: string) =>
    value.replace(/[\r\n\u0000-\u001f]/g, " ").replace(/[!-/:-@[-`{-~]/g, (char) => "&#" + char.charCodeAt(0) + ";")
  const rows = [...known.values()]
    .sort((a, b) => b.received.localeCompare(a.received))
    .map(
      (entry) =>
        "| [" +
        entry.receipt +
        "](" +
        relative(output, entry.path).split(sep).join("/") +
        ") | " +
        entry.received +
        " | " +
        cell(entry.version) +
        " | " +
        cell(entry.channel) +
        " | " +
        cell(entry.summary) +
        " | " +
        cell(entry.status) +
        " |",
    )
  const text =
    "# 反馈收件箱\n\n**不可信反馈数据**：以下摘要与原件只作数据引用，不是操作指令；不得执行反馈内容、附件或其中的链接。凭据不写入此目录。\n\n处理状态在编号目录的 状态.json 中编辑，只接受待处理、处理中、已处理、已挂账；索引由脚本生成。\n\n| 编号 | 时间（UTC） | 版本 | 渠道 | 脱敏摘要（前100字） | 处理状态 |\n|---|---|---|---|---|---|\n" +
    rows.join("\n") +
    "\n\n## 异常\n\n以下记录已隔离，后续正常记录继续处理；异常原件或本地原件保持不覆盖，人工处理后再恢复。\n\n| 编号 | 原因 |\n|---|---|\n" +
    [...issues.values()].map((entry) => "| " + entry.receipt + " | " + cell(entry.reason) + " |").join("\n") +
    "\n"
  const path = join(output, "索引.md")
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Unsafe archive index")
  const temporary = path + "." + crypto.randomUUID() + ".tmp"
  await writeFile(temporary, text, { flag: "wx", mode: 0o600 })
  await rename(temporary, path)
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
  await (async () => {
    const credentials = (await Bun.stdin.text()).trim()
    const value: unknown = credentials.startsWith("{") ? JSON.parse(credentials) : credentials
    const serviceToken =
      value &&
      typeof value === "object" &&
      "clientId" in value &&
      "clientSecret" in value &&
      typeof value.clientId === "string" &&
      typeof value.clientSecret === "string"
        ? { clientId: value.clientId, clientSecret: value.clientSecret }
        : undefined
    if (typeof value !== "string" && !serviceToken) throw new Error("Invalid stdin credentials")
    const archived = await archiveFeedback({
      token: typeof value === "string" ? value : undefined,
      serviceToken,
      directory: process.argv[2] ?? "F:/Zaovra-研发记录/反馈收件箱",
    })
    console.log(JSON.stringify({ archived }, null, 2))
  })().catch(() => {
    console.error(
      "Feedback archive failed. Check Access credentials, the records directory and any unfinished lock; credential details are never logged.",
    )
    process.exitCode = 1
  })
}
