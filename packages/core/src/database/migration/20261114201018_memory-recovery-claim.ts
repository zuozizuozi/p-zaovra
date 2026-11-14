import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261114201018_memory-recovery-claim",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_recovery_claim\` (
          \`note_id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`restored_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
