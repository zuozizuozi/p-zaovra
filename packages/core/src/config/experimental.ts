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
  verification: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Enable host verification prompts, review tool and closing review (default true). Disabling does not certify completion or suppress execution failures. Restart the backend after changing this experiment.",
  }),
  policies: Policy.pipe(Schema.Array, Schema.optional),
}) {}
