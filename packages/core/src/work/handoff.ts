export * as WorkHandoff from "./handoff"

import { Work } from "@zaovra-ai/schema/work"
import { Option, Schema } from "effect"

const HandoffJson = Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Work.HandoffOutput))
const decode = Schema.decodeUnknownOption(HandoffJson)

export function parse(text: string): Work.HandoffOutput {
  const match = text.match(/<work-handoff>\s*([\s\S]*?)\s*<\/work-handoff>/i)
  const output = Option.getOrUndefined(decode(match?.[1] ?? ""))
  const fallback = text
    .replace(/<work-handoff>[\s\S]*?<\/work-handoff>/gi, "")
    .trim()
    .slice(0, 12_000)
  const summary = output?.summary.trim().slice(0, 12_000) || fallback || "Task completed without a textual summary."
  const items = (output?.items ?? [])
    .filter((item) => item.text.trim().length > 0)
    .slice(0, 64)
    .map((item) => ({
      kind: item.kind,
      text: item.text.trim().slice(0, 4_000),
      ...(item.reference?.trim() ? { reference: item.reference.trim().slice(0, 2_000) } : {}),
      ...(item.memory ? { memory: item.memory } : {}),
      ...(item.key?.trim() ? { key: item.key.trim().slice(0, 200) } : {}),
      ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
    }))
  return Work.HandoffOutput.make({
    summary,
    items: items.length > 0 ? items : [{ kind: "result", text: summary.slice(0, 4_000) }],
  })
}

export function id(taskID: Work.TaskID) {
  return Work.HandoffID.make(`handoff_${hash(`task:${taskID}`)}`)
}

export function digest(output: Work.HandoffOutput, evidenceIDs: ReadonlyArray<Work.EvidenceID>) {
  return hash(JSON.stringify({ summary: output.summary, items: output.items, evidenceIDs }))
}

export function itemDigest(item: Work.HandoffItem) {
  return hash(JSON.stringify(item))
}

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}
