import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261114195357_memory-recovery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_recovery\` (
          \`scope\` text PRIMARY KEY,
          \`legacy_scope\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`state\` text DEFAULT 'pending' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
