import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261116061652_read-receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`read_receipt\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`called_seq\` integer NOT NULL,
          \`success_seq\` integer NOT NULL,
          \`directory\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`path\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`digest\` text NOT NULL,
          \`bytes\` integer NOT NULL,
          \`volume_id\` text NOT NULL,
          \`file_id\` text NOT NULL,
          \`written\` text NOT NULL,
          \`changed\` text NOT NULL,
          CONSTRAINT \`fk_read_receipt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`read_receipt_source_idx\` ON \`read_receipt\` (\`session_id\`,\`assistant_message_id\`,\`call_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
