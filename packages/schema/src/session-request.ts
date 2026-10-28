export * as SessionRequest from "./session-request"

type Message = {
  id: string
  type: string
  text?: string
  files?: readonly unknown[]
  agents?: readonly unknown[]
  subtask?: unknown
  invocation?: unknown
}
export const RECOVERY_PROMPT =
  "核对现场后继续上一项任务：先检查保留的日志、当前工作区和仍在运行的预览，确认已完成的部分与结果不明的操作。不要假定未结束的命令已经成功，也不要重复执行已完成的操作；未验证的结果需明确说明。"

// Only explicit continuation syntax establishes this relationship. Delivery
// scheduling (steer/queue) and model-generated summaries are not task identity.
export function continuationText(text = "") {
  if (text === RECOVERY_PROMPT) return ""
  if (/^(?:取消要求|撤销要求|将要求|修改要求)\s*[“「]/u.test(text.trim())) return text.trim()
  if (
    /^(?:请\s*)?(?:继续|继续执行|继续完成|继续修复|接着做)[。.!！\s]*$/u.test(text.trim()) ||
    /^(?:please\s+)?(?:continue|resume|keep going)[.!\s]*$/iu.test(text.trim())
  )
    return ""
  return text
    .trim()
    .match(
      /^(?:(?:请\s*)?(?:继续|继续执行|继续完成|继续修复|接着做)[，,:：]\s*|(?:补充要求|追加要求|修改要求)[:：]\s*|(?:please\s+)?(?:continue|resume|keep going)[,:]\s+)(.+)$/isu,
    )?.[1]
}

export function acceptanceHistory<T extends Message>(messages: readonly T[]) {
  let start = 0
  let original: T | undefined
  for (const [index, message] of messages.entries()) {
    if (message.type !== "user") continue
    const continuation =
      !message.files?.length &&
      !message.agents?.length &&
      !message.subtask &&
      !message.invocation &&
      continuationText(message.text ?? "") !== undefined
    const repeated =
      original &&
      (message.text ?? "") === original.text &&
      JSON.stringify([message.files, message.agents, message.subtask, message.invocation]) ===
        JSON.stringify([original.files, original.agents, original.subtask, original.invocation])
    if (original && (continuation || repeated)) continue
    original = message
    start = index
  }
  return messages.slice(start)
}

/** Stable references to the user's actual clauses, not a model-written replacement spec. */
export function requested<T extends Message>(messages: readonly T[], version: (text: string) => string) {
  const scope = acceptanceHistory(messages)
  const user = scope.find((message) => message.type === "user")
  const entries: {
    id: number
    text: string
    sourceMessageID: T["id"]
    sourceStart: number
    sourceEnd: number
    version: string
    data?: boolean
    withdrawnBy?: T["id"]
  }[] = []
  const seen = new Set<string>()
  const ordinary = new Set<string>()
  for (const message of scope) {
    if (message.type !== "user" || seen.has(message.id)) continue
    seen.add(message.id)
    const text =
      message.id === user?.id ? (message.text ?? "") : (continuationText(message.text ?? "") ?? message.text ?? "")
    // An exact, whole-message withdrawal can retire a clause without trusting
    // the model to waive it. Ambiguous corrections remain visible for review.
    const replacement = text
      .trim()
      .match(/^(?:将要求|修改要求)\s*[“「]([^”」]+)[”」]\s*(?:改为|替换为)\s*[“「]([^”」]+)[”」][。.!！\s]*$/u)
    const withdrawal =
      replacement?.[1] ?? text.trim().match(/^(?:取消要求|撤销要求)\s*[“「]([^”」]+)[”」][。.!！\s]*$/u)?.[1]
    // Explicit additions and amendments from distinct messages are new actions. Ordinary
    // repeated prompts still refer to the original clauses and their evidence.
    const amendment = withdrawal || continuationText(message.text ?? "") !== undefined
    if (!amendment && ordinary.has(message.text ?? "")) continue
    if (!amendment) ordinary.add(message.text ?? "")
    const matches = withdrawal ? entries.filter((entry) => entry.text === withdrawal && !entry.withdrawnBy) : []
    if (matches.length === 1) {
      matches[0].withdrawnBy = message.id
      if (!replacement) continue
    }
    const body = replacement && matches.length === 1 ? replacement[2] : text
    const fences = fencedRanges(message.text ?? "")
    let offset = (message.text ?? "").indexOf(body)
    for (const part of body.split(/(?<=[。；;\r\n])/u)) {
      const clause = part.trim()
      if (clause)
        entries.push({
          id: entries.length + 1,
          text: clause,
          sourceMessageID: message.id,
          sourceStart: offset + part.indexOf(clause),
          sourceEnd: offset + part.indexOf(clause) + clause.length,
          version: version(message.text ?? ""),
          ...(fences.some(([start, end]) => offset < end && offset + part.length > start) || /^\s*>/u.test(part)
            ? { data: true }
            : {}),
        })
      offset += part.length
    }
  }
  return {
    userMessageID: scope.findLast((message) => message.type === "user")?.id,
    sourceMessageID: user?.id,
    clauses: entries.map((entry) => entry.text),
    entries,
  }
}

/** CommonMark fences include their delimiters and run to EOF if unclosed. */
function fencedRanges(text: string) {
  const ranges: [number, number][] = []
  let open: { start: number; marker: string } | undefined
  for (const line of text.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/g)) {
    const content = line[0].replace(/(?:\r\n|[\r\n])$/, "")
    if (open) {
      const close = content.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (close && close[1][0] === open.marker[0] && close[1].length >= open.marker.length) {
        ranges.push([open.start, line.index + line[0].length])
        open = undefined
      }
      continue
    }
    const fence = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (!fence || (fence[1][0] === "`" && fence[2].includes("`"))) continue
    open = { start: line.index, marker: fence[1] }
  }
  if (open) ranges.push([open.start, text.length])
  return ranges
}
