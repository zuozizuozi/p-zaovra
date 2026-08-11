import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806193759_work_remote_artifacts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_worker_job_artifact\` (
          \`job_id\` text NOT NULL,
          \`digest\` text NOT NULL,
          \`worker_id\` text NOT NULL,
          \`fence\` integer NOT NULL,
          \`label\` text NOT NULL,
          \`reference\` text NOT NULL,
          \`size\` integer NOT NULL,
          \`media_type\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`work_worker_job_artifact_pk\` PRIMARY KEY(\`job_id\`, \`digest\`),
          CONSTRAINT \`fk_work_worker_job_artifact_job_id_work_worker_job_id_fk\` FOREIGN KEY (\`job_id\`) REFERENCES \`work_worker_job\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_worker_job_artifact_worker_id_work_worker_id_fk\` FOREIGN KEY (\`worker_id\`) REFERENCES \`work_worker\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_worker_job_log\` (
          \`job_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`worker_id\` text NOT NULL,
          \`fence\` integer NOT NULL,
          \`stream\` text NOT NULL,
          \`message\` text NOT NULL,
          \`size\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`work_worker_job_log_pk\` PRIMARY KEY(\`job_id\`, \`sequence\`),
          CONSTRAINT \`fk_work_worker_job_log_job_id_work_worker_job_id_fk\` FOREIGN KEY (\`job_id\`) REFERENCES \`work_worker_job\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_worker_job_log_worker_id_work_worker_id_fk\` FOREIGN KEY (\`worker_id\`) REFERENCES \`work_worker\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`work_worker_job_artifact_created_idx\` ON \`work_worker_job_artifact\` (\`job_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_worker_job_log_created_idx\` ON \`work_worker_job_log\` (\`job_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
