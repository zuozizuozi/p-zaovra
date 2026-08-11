import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806070515_work_handoff",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_handoff\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`attempt_id\` text NOT NULL,
          \`producer\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`items\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`digest\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_work_handoff_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_handoff_task_id_work_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`work_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_handoff_attempt_id_work_attempt_id_fk\` FOREIGN KEY (\`attempt_id\`) REFERENCES \`work_attempt\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_handoff_task_idx\` ON \`work_handoff\` (\`task_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_handoff_attempt_idx\` ON \`work_handoff\` (\`attempt_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`work_handoff_goal_created_idx\` ON \`work_handoff\` (\`goal_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
