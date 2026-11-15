import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261115181429_memory-pages",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_page\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`key\` text NOT NULL,
          \`title\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`body\` text NOT NULL,
          \`sources\` text NOT NULL,
          \`revision\` text NOT NULL,
          \`aliases\` text NOT NULL,
          \`time_deleted\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_page_tombstone\` (
          \`scope\` text NOT NULL,
          \`key\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`memory_page_scope_key_idx\` ON \`memory_page\` (\`scope\`,\`key\`);`)
      yield* tx.run(`CREATE INDEX \`memory_page_scope_updated_idx\` ON \`memory_page\` (\`scope\`,\`time_updated\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`memory_page_tombstone_scope_key_idx\` ON \`memory_page_tombstone\` (\`scope\`,\`key\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
