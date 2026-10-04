import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261004183352_work-local-acceptance",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`work_task\` ADD \`acceptance\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
