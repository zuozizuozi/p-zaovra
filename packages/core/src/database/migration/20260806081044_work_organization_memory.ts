import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806081044_work_organization_memory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_memory_resolution\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`workspace_id\` text,
          \`key\` text NOT NULL,
          \`handoff_id\` text NOT NULL,
          \`handoff_digest\` text NOT NULL,
          \`item_digest\` text NOT NULL,
          \`resolver\` text NOT NULL,
          \`reason\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_work_memory_resolution_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_memory_resolution_handoff_id_work_handoff_id_fk\` FOREIGN KEY (\`handoff_id\`) REFERENCES \`work_handoff\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`work_goal\` ADD \`role_contracts\` text DEFAULT '[]' NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX \`work_memory_resolution_location_key_created_idx\` ON \`work_memory_resolution\` (\`directory\`,\`workspace_id\`,\`key\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_memory_resolution_goal_created_idx\` ON \`work_memory_resolution\` (\`goal_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
