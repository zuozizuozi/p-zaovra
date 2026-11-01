import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { ProjectV2 } from "../project"
import { ProjectTable } from "../project/sql"
import type { PermissionSaved } from "./saved"

export const PermissionTable = sqliteTable(
  "permission",
  {
    id: text().$type<PermissionSaved.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    action: text().notNull(),
    resource: text().notNull(),
    match_mode: text().$type<PermissionSaved.Info["matchMode"]>().notNull().default("legacy"),
    origin: text().$type<PermissionSaved.Info["origin"]>().notNull().default("legacy"),
    version: integer().notNull().default(1),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("permission_project_action_resource_mode_origin_idx").on(
      table.project_id,
      table.action,
      table.resource,
      table.match_mode,
      table.origin,
    ),
  ],
)
