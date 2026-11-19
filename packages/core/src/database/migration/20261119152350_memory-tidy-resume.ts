import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261119152350_memory-tidy-resume",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`memory_tidy_run\` ADD \`budget_pause\` text;`)
      yield* tx.run(`ALTER TABLE \`memory_tidy_run\` ADD \`budget_resume\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
