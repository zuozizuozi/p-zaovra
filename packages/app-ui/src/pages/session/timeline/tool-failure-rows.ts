import type { Part } from "@zaovra-ai/sdk/v2"
import type { TimelineRow } from "./timeline-row"

/** Keep live chronology; settled blocking failures follow the answer and retain their original row identities. */
export function placeToolFailuresAfterAnswer(
  rows: TimelineRow.TimelineRow[],
  parts: (messageID: string) => Part[],
  quiet: ReadonlySet<string>,
  settled: boolean,
) {
  if (!settled) return rows
  const failures = rows.filter((row) => {
    if (row._tag !== "AssistantPart" || row.group.type !== "part") return false
    const ref = row.group.ref
    const part = parts(ref.messageID).find((part) => part.id === ref.partID)
    return (
      part?.type === "tool" &&
      part.state.status === "error" &&
      !(part.tool === "question" && part.state.error.includes("dismissed this question")) &&
      !quiet.has(part.id)
    )
  })
  if (!failures.length) return rows
  const moved = new Set(failures)
  return [...rows.filter((row) => !moved.has(row)), ...failures]
}
