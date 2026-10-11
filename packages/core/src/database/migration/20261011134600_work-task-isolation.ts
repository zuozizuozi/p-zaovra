import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261011134600_work-task-isolation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`work_task\` ADD \`isolation\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
