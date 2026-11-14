import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261113202309_agent-memory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_note\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`key\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`text\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`status\` text NOT NULL,
          \`verification\` text,
          \`session_id\` text,
          \`seq\` integer,
          \`hits\` integer DEFAULT 1 NOT NULL,
          \`time_observed\` integer NOT NULL,
          \`time_deleted\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`memory_note_scope_key_idx\` ON \`memory_note\` (\`scope\`,\`key\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_note_scope_time_updated_idx\` ON \`memory_note\` (\`scope\`,\`time_updated\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
