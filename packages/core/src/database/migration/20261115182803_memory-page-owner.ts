import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261115182803_memory-page-owner",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`memory_page\` ADD \`origin\` text DEFAULT 'consolidation' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
