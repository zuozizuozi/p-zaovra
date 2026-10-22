import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261022070946_session-host-completion",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`completion\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
