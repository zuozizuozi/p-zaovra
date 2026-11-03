import type { Part } from "@zaovra-ai/sdk/v2"

/** Group durable shell updates by job identity, never by command text. */
export function processMessages(parts: readonly Part[], representedJobs: ReadonlySet<string>) {
  const entries = new Map<string, { id: string; title: string; text: string; pending: boolean }>()
  parts.forEach((part) => {
    if (part.type !== "text" || !part.synthetic || !part.text.trim()) return
    const metadata = part.metadata
    const jobID = metadata?.zaovraShellJobID ?? metadata?.zaovraCompletionJobID
    if (typeof jobID === "string" && representedJobs.has(jobID)) return
    const key = typeof jobID === "string" ? jobID : part.id
    const previous = entries.get(key)
    entries.set(key, {
      id: key,
      title:
        typeof metadata?.zaovraShellCommand === "string"
          ? metadata.zaovraShellCommand
          : (previous?.title ?? "过程记录"),
      text: [previous?.text, part.text]
        .filter((value, index, values) => value && values.indexOf(value) === index)
        .join("\n\n"),
      pending: metadata?.zaovraCompletionJobID ? false : metadata?.zaovraShellPending === true,
    })
  })
  return [...entries.values()]
}
