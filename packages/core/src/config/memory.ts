export * as ConfigMemory from "./memory"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  taskSearch: Schema.optional(Schema.Boolean).annotate({
    description: "Search local notes and topic pages once per new user task (default true). No model call is made.",
  }),
  index: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      maxLines: Schema.optional(PositiveInt.check(Schema.isGreaterThanOrEqualTo(8), Schema.isLessThanOrEqualTo(200))),
      maxBytes: Schema.optional(
        PositiveInt.check(Schema.isGreaterThanOrEqualTo(1024), Schema.isLessThanOrEqualTo(25 * 1024)),
      ),
    }),
  ).annotate({
    description:
      "Startup index limits including guidance: default 60 lines / 4096 UTF-8 bytes; refreshes only on a new context generation.",
  }),
})
