import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806180810_work_remote_jobs",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_worker_job\` (
          \`id\` text PRIMARY KEY,
          \`worker_id\` text NOT NULL,
          \`goal_id\` text NOT NULL,
          \`attempt_id\` text NOT NULL,
          \`criterion_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`fence\` integer NOT NULL,
          \`operation\` text NOT NULL,
          \`result\` text,
          \`lease_expires_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_work_worker_job_worker_id_work_worker_id_fk\` FOREIGN KEY (\`worker_id\`) REFERENCES \`work_worker\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_worker_job_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_worker_job_attempt_id_work_attempt_id_fk\` FOREIGN KEY (\`attempt_id\`) REFERENCES \`work_attempt\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`work_worker\` ADD \`execution_mode\` text DEFAULT 'shared' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`work_worker\` ADD \`location_mappings\` text DEFAULT '[]' NOT NULL;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`work_worker_job_attempt_criterion_idx\` ON \`work_worker_job\` (\`attempt_id\`,\`criterion_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_worker_job_worker_status_created_idx\` ON \`work_worker_job\` (\`worker_id\`,\`status\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`work_worker_job_lease_expires_idx\` ON \`work_worker_job\` (\`lease_expires_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
