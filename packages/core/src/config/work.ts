export * as ConfigWork from "./work"

import { Work } from "@zaovra-ai/schema/work"
import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigV2.Work")({
  roles: Schema.Array(Work.RoleContract).pipe(Schema.optional).annotate({
    description: "Organization Role Contracts merged by role ID and snapshotted into each new durable WorkGraph Goal",
  }),
}) {}
