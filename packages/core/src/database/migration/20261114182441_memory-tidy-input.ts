import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261114182441_memory-tidy-input",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`memory_tidy_run\` ADD \`input\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
