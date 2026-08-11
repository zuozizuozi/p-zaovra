import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811062621_work-memory-control",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`work_memory_resolution\` ADD \`action\` text DEFAULT 'select' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`work_memory_resolution\` ADD \`value\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
