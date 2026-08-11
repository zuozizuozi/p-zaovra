import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806090711_work_worker_credentials",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`work_worker\` ADD \`credential_hash\` text;`)
      yield* tx.run(`ALTER TABLE \`work_worker\` ADD \`credential_created_at\` integer;`)
      yield* tx.run(`ALTER TABLE \`work_worker\` ADD \`credential_last_used_at\` integer;`)
      yield* tx.run(`ALTER TABLE \`work_worker\` ADD \`credential_revoked_at\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
