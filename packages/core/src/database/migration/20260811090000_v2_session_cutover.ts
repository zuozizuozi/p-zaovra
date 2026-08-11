import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811090000_v2_session_cutover",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TEMP TABLE \`_v1_session_cutover\` AS
        SELECT \`session\`.\`id\`
        FROM \`session\`
        WHERE NOT EXISTS (
          SELECT 1
          FROM \`event\`
          WHERE \`event\`.\`aggregate_id\` = \`session\`.\`id\`
            AND \`event\`.\`type\` = 'session.next.created.1'
        );
      `)
      yield* tx.run(
        `DELETE FROM \`event_sequence\` WHERE \`aggregate_id\` IN (SELECT \`id\` FROM \`_v1_session_cutover\`);`,
      )
      yield* tx.run(`DELETE FROM \`session\` WHERE \`id\` IN (SELECT \`id\` FROM \`_v1_session_cutover\`);`)
      yield* tx.run(`DROP TABLE \`_v1_session_cutover\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
