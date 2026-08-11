import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806021945_work_lease",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_lease\` (
          \`goal_id\` text PRIMARY KEY,
          \`owner_id\` text NOT NULL,
          \`fence\` integer NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_work_lease_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`work_lease_expires_idx\` ON \`work_lease\` (\`expires_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
