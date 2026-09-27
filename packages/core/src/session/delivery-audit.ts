export * as DeliveryAudit from "./delivery-audit"

import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import path from "node:path"
import { FSUtil } from "../fs-util"

export const Observation = Schema.Struct({
  requirement: Schema.Number,
  path: Schema.String,
  digest: Schema.String,
  problem: Schema.optional(Schema.String),
})
export type Observation = typeof Observation.Type

/** Deliberately narrow: a whole imperative clause, not an arbitrary filename
 * mention. Conditions, negation, examples and multiple-file prose are left to
 * ordinary requirement review, never converted into unconditional obligations.
 */
export function expected(entries: readonly { id: number; text: string; withdrawnBy?: string }[]) {
  return entries.flatMap((entry) => {
    if (entry.withdrawnBy) return []
    const match = entry.text
      .trim()
      .match(
        /^(?:(?:请)?(?:并|再|最终|最后|必须)?(?:创建|编写|交付|提供|生成|保留)(空文件\s*|文件\s*)?\s*|(?:please\s+)?(?:finally\s+)?(?:create|write|deliver|provide|keep)\s+(?:(an? empty file|a file|the file)\s+)?)(?:`([^`]+)`|([^\s`，,。；;]+?))(?:\s*(?:文件|文档))?(?:[，,]\s*(?:说明|包含|内容如下)[:：])?[。；;.!\s]*$/iu,
      )
    if (!match) return []
    const file = match[3] ?? match[4]
    if (!/^(?:README|.+\.[\w-]+|\.[\w-]+)$/iu.test(file)) return []
    return [
      {
        requirement: entry.id,
        path: file,
        nonempty: /^readme(?:\.[\w-]+)?$/i.test(path.basename(file)) && !/empty|空/.test(match[1] ?? match[2] ?? ""),
      },
    ]
  })
}

export const inspect = (fs: FSUtil.Interface, directory: string, entries: Parameters<typeof expected>[0]) =>
  Effect.forEach(expected(entries), (item) =>
    Effect.gen(function* () {
      const invalid =
        path.isAbsolute(item.path) ||
        path.win32.isAbsolute(item.path) ||
        item.path.split(/[\\/]/).some((part) => part === "..") ||
        /[:\0]/.test(item.path)
      if (invalid)
        return {
          requirement: item.requirement,
          path: item.path,
          digest: "",
          problem: "outside workspace or invalid path",
        }
      const root = yield* fs.realPath(directory)
      const names = /^readme$/i.test(item.path) ? yield* fs.readDirectory(directory) : []
      const file = /^readme$/i.test(item.path)
        ? (names.find((name) => /^readme\.md$/i.test(name)) ??
          names.sort().find((name) => /^readme(?:\.(?:txt|rst|markdown))?$/i.test(name)) ??
          "README.md")
        : item.path
      const target = yield* fs.realPath(path.resolve(directory, file))
      const relative = path.relative(root, target)
      // Check the resolved target, including Windows junctions, before reading it.
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
        return { requirement: item.requirement, path: item.path, digest: "", problem: "outside workspace" }
      const info = yield* fs.stat(target)
      if (info.type !== "File" || info.size > 64 * 1024 * 1024)
        return {
          requirement: item.requirement,
          path: item.path,
          digest: "",
          problem: "not a readable file within audit size limit",
        }
      const bytes = yield* fs.readFile(target)
      if (item.nonempty && !new TextDecoder().decode(bytes).trim())
        return { requirement: item.requirement, path: item.path, digest: "", problem: "empty required document" }
      return { requirement: item.requirement, path: target, digest: createHash("sha256").update(bytes).digest("hex") }
    }).pipe(
      Effect.catch(() =>
        Effect.succeed({
          requirement: item.requirement,
          path: item.path,
          digest: "",
          problem: "missing or unreadable required file",
        }),
      ),
    ),
  )
