import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260805191955_work_graph",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_attempt\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`number\` integer NOT NULL,
          \`session_id\` text,
          \`status\` text NOT NULL,
          \`owner_id\` text,
          \`fence\` integer,
          \`input_revision\` integer NOT NULL,
          \`failure\` text,
          \`time_created\` integer NOT NULL,
          \`time_started\` integer,
          \`time_ended\` integer,
          CONSTRAINT \`fk_work_attempt_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_attempt_task_id_work_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`work_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_attempt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_evaluation\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`attempt_id\` text NOT NULL,
          \`criterion_id\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`verdict\` text NOT NULL,
          \`evaluator\` text NOT NULL,
          \`evaluator_version\` text NOT NULL,
          \`findings\` text NOT NULL,
          \`allows_repair\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_work_evaluation_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_evaluation_task_id_work_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`work_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_evaluation_attempt_id_work_attempt_id_fk\` FOREIGN KEY (\`attempt_id\`) REFERENCES \`work_attempt\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_evidence\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`attempt_id\` text NOT NULL,
          \`criterion_ids\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`producer\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`digest\` text,
          \`reference\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_work_evidence_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_evidence_task_id_work_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`work_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_evidence_attempt_id_work_attempt_id_fk\` FOREIGN KEY (\`attempt_id\`) REFERENCES \`work_attempt\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_goal\` (
          \`id\` text PRIMARY KEY,
          \`directory\` text NOT NULL,
          \`workspace_id\` text,
          \`objective\` text NOT NULL,
          \`acceptance_criteria\` text NOT NULL,
          \`status\` text NOT NULL,
          \`budget\` text,
          \`usage\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_task\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`instructions\` text NOT NULL,
          \`depends_on\` text NOT NULL,
          \`role\` text NOT NULL,
          \`directory\` text,
          \`workspace_id\` text,
          \`status\` text NOT NULL,
          \`criteria\` text NOT NULL,
          \`attempt_count\` integer NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_work_task_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`work_attempt_task_number_idx\` ON \`work_attempt\` (\`task_id\`,\`number\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_attempt_goal_status_created_idx\` ON \`work_attempt\` (\`goal_id\`,\`status\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`work_attempt_session_idx\` ON \`work_attempt\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`work_evaluation_task_criterion_created_idx\` ON \`work_evaluation\` (\`task_id\`,\`criterion_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_evaluation_attempt_created_idx\` ON \`work_evaluation\` (\`attempt_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_evidence_attempt_created_idx\` ON \`work_evidence\` (\`attempt_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_evidence_task_created_idx\` ON \`work_evidence\` (\`task_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_goal_location_status_updated_idx\` ON \`work_goal\` (\`directory\`,\`workspace_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_task_goal_status_created_idx\` ON \`work_task\` (\`goal_id\`,\`status\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`work_task_status_updated_idx\` ON \`work_task\` (\`status\`,\`time_updated\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
