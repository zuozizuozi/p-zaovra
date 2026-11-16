import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261116054623_memory-automatic",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_automatic_run\` (
          \`run_id\` text PRIMARY KEY,
          \`directory\` text NOT NULL,
          \`generation\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_automatic_source\` (
          \`directory\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`input_seq\` integer NOT NULL,
          CONSTRAINT \`memory_automatic_source_pk\` PRIMARY KEY(\`directory\`, \`session_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_automatic\` (
          \`directory\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`generation\` text NOT NULL,
          \`enabled\` integer NOT NULL,
          \`model\` text NOT NULL,
          \`token_limit\` integer NOT NULL,
          \`daily_limit\` integer NOT NULL,
          \`current_run\` text,
          \`time_confirmed\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
