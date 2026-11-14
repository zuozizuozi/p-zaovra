import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261114170409_memory-tidy-budget",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_tidy_attempt\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`day\` text NOT NULL,
          \`reserved\` integer NOT NULL,
          \`actual\` integer,
          \`time_created\` integer NOT NULL,
          \`time_settled\` integer,
          CONSTRAINT \`fk_memory_tidy_attempt_run_id_memory_tidy_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`memory_tidy_run\`(\`id\`),
          CONSTRAINT \`fk_memory_tidy_attempt_day_memory_tidy_day_day_fk\` FOREIGN KEY (\`day\`) REFERENCES \`memory_tidy_day\`(\`day\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_tidy_day\` (
          \`day\` text PRIMARY KEY,
          \`token_limit\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_tidy_run\` (
          \`id\` text PRIMARY KEY,
          \`request_id\` text NOT NULL UNIQUE,
          \`session_id\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`model\` text NOT NULL,
          \`token_limit\` integer NOT NULL,
          \`daily_limit\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_finished\` integer
        );
      `)
      yield* tx.run(`CREATE INDEX \`memory_tidy_attempt_run_idx\` ON \`memory_tidy_attempt\` (\`run_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_tidy_attempt_day_idx\` ON \`memory_tidy_attempt\` (\`day\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`memory_tidy_run_session_idx\` ON \`memory_tidy_run\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
