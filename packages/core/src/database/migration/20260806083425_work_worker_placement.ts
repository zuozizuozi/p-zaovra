import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806083425_work_worker_placement",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_worker\` (
          \`id\` text PRIMARY KEY,
          \`label\` text NOT NULL,
          \`endpoint\` text,
          \`capabilities\` text NOT NULL,
          \`workspace_roots\` text NOT NULL,
          \`draining\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_heartbeat\` integer NOT NULL,
          \`expires_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`work_goal\` ADD \`worker_id\` text;`)
      yield* tx.run(`ALTER TABLE \`work_lease\` ADD \`worker_id\` text DEFAULT 'worker_local' NOT NULL;`)
      yield* tx.run(`CREATE INDEX \`work_worker_expires_idx\` ON \`work_worker\` (\`expires_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
