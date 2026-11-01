import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigCompaction } from "../src/config/compaction"

test("V2 rejects enabling unsupported compaction pruning with an actionable message", () => {
  expect(() => Schema.decodeUnknownSync(ConfigCompaction.Info)({ prune: true })).toThrow(
    "compaction.prune is not supported in V2",
  )
  expect(Schema.decodeUnknownSync(ConfigCompaction.Info)({ auto: true, prune: false }).prune).toBe(false)
  expect(Schema.decodeUnknownSync(ConfigCompaction.Info)({ auto: true }).prune).toBeUndefined()
})
