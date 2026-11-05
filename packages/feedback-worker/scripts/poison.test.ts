import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { safeSnapshot } from "../src/index"
import { feedbackMetadata } from "../src/metadata"
import { archiveFeedback } from "./archive-feedback"
const root = process.env.ZAOVRA_WORKER_TEST_DIR
if (!root) throw new Error("Use an isolated fixture directory")
function record(receipt: string, description = "正常反馈") {
  return {
    received: "2026-11-05T04:00:00.000Z",
    snapshot: { text: JSON.stringify({ reportID: receipt, description }) },
  }
}
test("205 accepted compact reports remain readable after redaction expands them beyond 32k", () => {
  const receipt = crypto.randomUUID()
  const text = JSON.stringify({ reportID: receipt, description: "正常反馈", extra: Array(5000).fill(0) })
  expect(text.length).toBeLessThan(32_000)
  const accepted = safeSnapshot({ text, files: [{ name: "report.json", text }] })
  expect(accepted.snapshot.text.length).toBeGreaterThan(32_000)
  expect(
    feedbackMetadata(receipt, { received: "2026-11-05T04:00:00.000Z", snapshot: accepted.snapshot }),
  ).toMatchObject({ receipt, summary: "正常反馈" })
})
test("205 poison first is quarantined once while later good reports archive across consecutive polls", async () => {
  const output = join(root, crypto.randomUUID())
  await mkdir(output, { recursive: true })
  const bad = "00000000-0000-4000-8000-000000000001"
  const good = "ffffffff-ffff-4fff-bfff-ffffffffffff"
  const downloads = { bad: 0, good: 0 }
  const fetcher = async (url: string) => {
    if (url.endsWith("/reports")) return Response.json({ reports: [{ receipt: bad }, { receipt: good }], cursor: null })
    if (url.endsWith(bad)) {
      downloads.bad++
      return Response.json({ received: "invalid", snapshot: { text: "not-json" } })
    }
    downloads.good++
    return Response.json(record(good))
  }
  const input = { token: "fixture-token", directory: output, archiveRoot: root, fetcher }
  expect((await archiveFeedback(input)).map((x) => x.receipt)).toEqual([good])
  expect(await archiveFeedback(input)).toEqual([])
  expect(downloads).toEqual({ bad: 1, good: 1 })
  const index = await readFile(join(output, "索引.md"), "utf8")
  expect(index).toContain("异常")
  expect(index).toContain(bad)
  expect(index).toContain(good)
})
test("205 corrupt retained originals do not block later records or get overwritten", async () => {
  const output = join(root, crypto.randomUUID())
  await mkdir(output, { recursive: true })
  const bad = crypto.randomUUID(),
    good = crypto.randomUUID()
  const original = join(output, bad + ".json")
  await writeFile(original, "{")
  let downloads = 0
  const archived = await archiveFeedback({
    token: "fixture-token",
    directory: output,
    archiveRoot: root,
    fetcher: async (url) => {
      if (url.endsWith("/reports"))
        return Response.json({ reports: [{ receipt: bad }, { receipt: good }], cursor: null })
      downloads++
      return Response.json(record(good))
    },
  })
  expect(archived.map((x) => x.receipt)).toEqual([good])
  expect(downloads).toBe(1)
  expect(await readFile(original, "utf8")).toBe("{")
  expect(await readFile(join(output, "索引.md"), "utf8")).toContain(bad)
})
test("205 feedback summaries remain inert Markdown text while Chinese and table structure survive", async () => {
  const output = join(root, crypto.randomUUID())
  await mkdir(output, { recursive: true })
  const receipt = crypto.randomUUID()
  await archiveFeedback({
    token: "fixture-token",
    directory: output,
    archiveRoot: root,
    fetcher: async (url) =>
      Response.json(
        url.endsWith("/reports")
          ? { reports: [{ receipt }], cursor: null }
          : record(receipt, "中文 ![](//fixture.example.invalid/track) [跳转](https://fixture.example.invalid) | code"),
      ),
  })
  const index = await readFile(join(output, "索引.md"), "utf8")
  expect(index).toContain("中文")
  expect(index).toContain("| 编号 |")
  expect(index).not.toContain("![](")
  expect(index).not.toContain("[跳转](")
})
