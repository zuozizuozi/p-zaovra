import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261101073309_permission-literal-origin",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`permission\` ADD \`match_mode\` text DEFAULT 'legacy' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`permission\` ADD \`origin\` text DEFAULT 'legacy' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`permission\` ADD \`version\` integer DEFAULT 1 NOT NULL;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`permission_project_action_resource_idx\`;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_mode_origin_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`,\`match_mode\`,\`origin\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
