export * as ConfigExperimental from "./experimental"

import { Schema } from "effect"
import { Catalog } from "../catalog"
import { Policy as PolicyV2 } from "../policy"

// Each core domain exports the policy actions it supports. Adding an action to
// this union makes it valid in authored config while keeping Policy generic.
export const PolicyAction = Schema.Union([Catalog.PolicyActions])

export class Policy extends Schema.Class<Policy>("ConfigV2.Experimental.Policy")({
  ...PolicyV2.Info.fields,
  action: PolicyAction,
}) {}

export class Experimental extends Schema.Class<Experimental>("ConfigV2.Experimental")({
  delivery_contract: Schema.optional(Schema.Boolean).annotate({
    description:
      "Lightweight delivery guidance and one bounded closing audit default on. Set false to disable automatic closing; this does not enable strict verification or authorize external actions.",
  }),
  quality_progress: Schema.optional(
    Schema.Struct({
      facts: Schema.optional(Schema.Boolean),
      silent_command_ms: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
      evidence_closing: Schema.optional(Schema.Boolean),
      stagnation_log: Schema.optional(Schema.Boolean),
      stagnation_reminder: Schema.optional(Schema.Boolean),
      independent_review: Schema.optional(Schema.Boolean),
      deadline: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))),
    }),
  ).annotate({
    description:
      "Quality observations facts and stagnation_log default on; set either to false to disable. evidence_closing, independent_review, stagnation_reminder and silent_command_ms default off. stagnation_reminder requires three consecutive known same-hypothesis observations with unchanged evidence, never stops work. silent_command_ms enables managed silence yielding (suggested 60000); deadline is an explicit Unix epoch in milliseconds, advisory only. Restart the backend after changing configuration.",
  }),
  verification: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Opt into strict host verification prompts, review tool and closing review (default false). By default, checks are advisory and do not determine run completion. Execution failures remain failures. Restart the backend after changing this experiment.",
  }),
  policies: Policy.pipe(Schema.Array, Schema.optional),
}) {}
