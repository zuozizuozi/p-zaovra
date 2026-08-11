import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806223623_work_artifact_lifecycle",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_artifact_owner\` (
          \`digest\` text NOT NULL,
          \`owner_type\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`work_artifact_owner_pk\` PRIMARY KEY(\`digest\`, \`owner_type\`, \`owner_id\`),
          CONSTRAINT \`fk_work_artifact_owner_digest_work_artifact_digest_fk\` FOREIGN KEY (\`digest\`) REFERENCES \`work_artifact\`(\`digest\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_artifact\` (
          \`digest\` text PRIMARY KEY,
          \`reference\` text NOT NULL,
          \`size\` integer NOT NULL,
          \`media_type\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_accessed\` integer NOT NULL,
          \`time_collected\` integer
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`work_artifact_owner_owner_idx\` ON \`work_artifact_owner\` (\`owner_type\`,\`owner_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_artifact_accessed_idx\` ON \`work_artifact\` (\`time_collected\`,\`time_accessed\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
