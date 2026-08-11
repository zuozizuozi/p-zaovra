import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806073810_work_handoff_routing",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`work_handoff\` ADD \`recipients\` text DEFAULT '[]' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
