import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261115184829_memory-file-links",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`memory_note\` ADD \`file_revision\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`memory_note\` ADD \`files\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
