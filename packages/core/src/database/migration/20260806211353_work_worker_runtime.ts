import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806211353_work_worker_runtime",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_worker_job_outbox\` (
          \`job_id\` text PRIMARY KEY,
          \`worker_id\` text NOT NULL,
          \`runtime_id\` text NOT NULL,
          \`fence\` integer NOT NULL,
          \`operation\` text NOT NULL,
          \`state\` text NOT NULL,
          \`result\` text,
          \`artifacts\` text DEFAULT '[]' NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`work_worker_job\` ADD \`lease_runtime_id\` text;`)
      yield* tx.run(`ALTER TABLE \`work_worker_job\` ADD \`cancel_reason\` text;`)
      yield* tx.run(`ALTER TABLE \`work_worker_job\` ADD \`cancel_requested_at\` integer;`)
      yield* tx.run(`ALTER TABLE \`work_worker\` ADD \`runtime_id\` text;`)
      yield* tx.run(`ALTER TABLE \`work_worker\` ADD \`capacity\` integer DEFAULT 1 NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX \`work_worker_job_outbox_state_updated_idx\` ON \`work_worker_job_outbox\` (\`state\`,\`time_updated\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
