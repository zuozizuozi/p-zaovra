export * as PermissionSaved from "./permission-saved"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { ProjectID } from "./project-id"
import { statics } from "./schema"

export const ID = Schema.String.pipe(
  Schema.brand("PermissionSaved.ID"),
  statics((schema) => ({ create: () => schema.make("psv_" + ascending()) })),
)
export type ID = typeof ID.Type

export const MatchMode = Schema.Literals(["literal", "pattern", "legacy"])
export const Origin = Schema.Literals(["internal", "api", "legacy"])

export const Info = Schema.Struct({
  id: ID,
  projectID: ProjectID,
  action: Schema.String,
  resource: Schema.String,
  matchMode: MatchMode,
  origin: Origin,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
}).annotate({ identifier: "PermissionSaved.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
