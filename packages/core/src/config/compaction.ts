export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.check(
    Schema.makeFilter((enabled) => !enabled || "compaction.prune is not supported in V2; remove it or set false."),
  ).pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
}) {}
