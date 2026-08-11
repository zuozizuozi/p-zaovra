import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806222919_work_controller_cluster",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_controller_dispatch\` (
          \`goal_id\` text PRIMARY KEY,
          \`signal\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`processed_revision\` integer DEFAULT 0 NOT NULL,
          \`controller_id\` text,
          \`runtime_id\` text,
          \`fence\` integer DEFAULT 0 NOT NULL,
          \`lease_expires_at\` integer,
          \`time_requested\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_work_controller_dispatch_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_controller\` (
          \`id\` text PRIMARY KEY,
          \`runtime_id\` text NOT NULL,
          \`label\` text NOT NULL,
          \`endpoint\` text,
          \`draining\` integer DEFAULT false NOT NULL,
          \`time_started\` integer NOT NULL,
          \`time_heartbeat\` integer NOT NULL,
          \`expires_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`work_lease\` ADD \`controller_id\` text;`)
      yield* tx.run(`ALTER TABLE \`work_lease\` ADD \`controller_runtime_id\` text;`)
      yield* tx.run(
        `CREATE INDEX \`work_controller_dispatch_pending_idx\` ON \`work_controller_dispatch\` (\`processed_revision\`,\`revision\`,\`time_requested\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_controller_dispatch_lease_idx\` ON \`work_controller_dispatch\` (\`lease_expires_at\`);`,
      )
      yield* tx.run(`CREATE INDEX \`work_controller_expires_idx\` ON \`work_controller\` (\`expires_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
