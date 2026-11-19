import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261119162225_memory-tidy-count",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_tidy_count\` (
          \`directory\` text NOT NULL,
          \`binding\` text NOT NULL,
          CONSTRAINT \`memory_tidy_count_pk\` PRIMARY KEY(\`directory\`, \`binding\`)
        );
      `)
      yield* tx.run(`ALTER TABLE \`memory_automatic\` ADD \`count_binding\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
