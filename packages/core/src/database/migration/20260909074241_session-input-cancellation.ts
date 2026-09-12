import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260909074241_session-input-cancellation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`cancelled_seq\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
