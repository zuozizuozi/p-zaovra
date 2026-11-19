import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261119153927_memory-extracted-digest",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`memory_note\` ADD \`extracted_digest\` text;`)
      yield* tx.run(
        `CREATE INDEX \`memory_note_scope_extracted_digest_idx\` ON \`memory_note\` (\`scope\`,\`extracted_digest\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
