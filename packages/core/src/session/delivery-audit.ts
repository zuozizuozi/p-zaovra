export * as DeliveryAudit from "./delivery-audit"

import { Clock, Effect, Option, Schema } from "effect"
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

export const budget = { files: 32, bytes: 8 * 1024 * 1024, durationMs: 2_000 } as const

/** Deliberately narrow: a whole imperative clause, not an arbitrary filename
 * mention. Conditions, negation, examples and multiple-file prose are left to
 * ordinary requirement review, never converted into unconditional obligations.
 */
export function expected(entries: readonly { id: number; text: string; data?: boolean; withdrawnBy?: string }[]) {
  return entries.flatMap((entry) => {
    if (entry.withdrawnBy || entry.data) return []
    const match = entry.text
      .trim()
      .match(
        /^(?:(?:请)?(?:并|再|最终|最后|必须)?(?:创建|编写|交付|提供|生成|保留)(空文件\s*|文件\s*)?\s*|(?:please\s+)?(?:finally\s+)?(?:create|write|deliver|provide|keep)\s+(?:(an? empty file|a file|the file)\s+)?)(?:`([^`]+)`|([^\s`，,。；;]+?))(?:\s*(?:文件|文档))?(?:[，,]\s*(?:说明|包含|内容如下)[:：])?[。；;.!\s]*$/iu,
      )
    const typed = entry.text
      .trim()
      .match(
        /^(?:(?:请)?(?:创建|交付|生成)\s*|(?:please\s+)?(?:create|deliver|write)\s+)?`([^`]+\.json)`[，,\s]+(?:顶层(?:必须)?(?:为|是)|(?:must be|as)\s+)(数组|对象|字符串|数值|布尔值|array|object|string|number|boolean)[。.!\s]*$/iu,
      )
    if (!match && !typed) return []
    const file = typed?.[1] ?? match![3] ?? match![4]
    if (!/^(?:README|.+\.[\w-]+|\.[\w-]+)$/iu.test(file)) return []
    return [
      {
        requirement: entry.id,
        path: file,
        nonempty:
          /^readme(?:\.[\w-]+)?$/i.test(path.basename(file)) && !/empty|空/.test(match?.[1] ?? match?.[2] ?? ""),
        ...(typed ? { shape: typed[2].toLowerCase() } : {}),
      },
    ]
  })
}

export const inspect = (fs: FSUtil.Interface, directory: string, entries: Parameters<typeof expected>[0]) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    let bytesRead = 0
    return yield* Effect.forEach(expected(entries), (item, index) =>
      Effect.gen(function* () {
        const remaining = budget.durationMs - ((yield* Clock.currentTimeMillis) - started)
        if (remaining <= 0)
          return {
            requirement: item.requirement,
            path: item.path,
            digest: "",
            problem: "unverified: wall-clock check budget exhausted",
          }
        return yield* Effect.gen(function* () {
          if (index >= budget.files)
            return {
              requirement: item.requirement,
              path: item.path,
              digest: "",
              problem: "unverified: file-check budget exhausted",
            }
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
          if (info.type !== "File" || Number(info.size) > budget.bytes || bytesRead + Number(info.size) > budget.bytes)
            return {
              requirement: item.requirement,
              path: item.path,
              digest: "",
              problem: "unverified: not a file or byte-check budget exhausted",
            }
          bytesRead += Number(info.size)
          const bytes = yield* fs.readFile(target)
          if (item.nonempty && !new TextDecoder().decode(bytes).trim())
            return { requirement: item.requirement, path: item.path, digest: "", problem: "empty required document" }
          if (/\.json$/i.test(item.path)) {
            const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(new TextDecoder().decode(bytes))
            if (Option.isNone(json))
              return { requirement: item.requirement, path: item.path, digest: "", problem: "invalid JSON" }
            const shape = Array.isArray(json.value) ? "array" : json.value === null ? "null" : typeof json.value
            const names: Record<string, string> = {
              数组: "array",
              对象: "object",
              字符串: "string",
              数值: "number",
              布尔值: "boolean",
            }
            if (item.shape && shape !== (names[item.shape] ?? item.shape))
              return {
                requirement: item.requirement,
                path: item.path,
                digest: "",
                problem: `JSON type is ${shape}; required ${item.shape}`,
              }
          }
          return {
            requirement: item.requirement,
            path: target,
            digest: createHash("sha256").update(bytes).digest("hex"),
          }
        }).pipe(
          Effect.timeoutOption(remaining),
          Effect.map((value) =>
            Option.isSome(value)
              ? value.value
              : {
                  requirement: item.requirement,
                  path: item.path,
                  digest: "",
                  problem: "unverified: wall-clock check budget exhausted",
                },
          ),
          Effect.catch(() =>
            Effect.succeed({
              requirement: item.requirement,
              path: item.path,
              digest: "",
              problem: "missing or unreadable required file",
            }),
          ),
        )
      }),
    )
  })
