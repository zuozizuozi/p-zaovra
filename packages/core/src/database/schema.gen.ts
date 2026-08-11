import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`work_attempt\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`number\` integer NOT NULL,
          \`session_id\` text,
          \`status\` text NOT NULL,
          \`owner_id\` text,
          \`fence\` integer,
          \`input_revision\` integer NOT NULL,
          \`failure\` text,
          \`time_created\` integer NOT NULL,
          \`time_started\` integer,
          \`time_ended\` integer,
          CONSTRAINT \`fk_work_attempt_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_attempt_task_id_work_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`work_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_attempt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_controller_dispatch\` (
          \`goal_id\` text PRIMARY KEY,
          \`signal\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`processed_revision\` integer DEFAULT 0 NOT NULL,
          \`controller_id\` text,
          \`runtime_id\` text,
          \`fence\` integer DEFAULT 0 NOT NULL,
          \`lease_expires_at\` integer,
          \`time_requested\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_work_controller_dispatch_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_controller\` (
          \`id\` text PRIMARY KEY,
          \`runtime_id\` text NOT NULL,
          \`label\` text NOT NULL,
          \`endpoint\` text,
          \`draining\` integer DEFAULT false NOT NULL,
          \`time_started\` integer NOT NULL,
          \`time_heartbeat\` integer NOT NULL,
          \`expires_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_evaluation\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`attempt_id\` text NOT NULL,
          \`criterion_id\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`verdict\` text NOT NULL,
          \`evaluator\` text NOT NULL,
          \`evaluator_version\` text NOT NULL,
          \`findings\` text NOT NULL,
          \`allows_repair\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_work_evaluation_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_evaluation_task_id_work_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`work_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_evaluation_attempt_id_work_attempt_id_fk\` FOREIGN KEY (\`attempt_id\`) REFERENCES \`work_attempt\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_evidence\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`attempt_id\` text NOT NULL,
          \`criterion_ids\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`producer\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`digest\` text,
          \`reference\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_work_evidence_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_evidence_task_id_work_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`work_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_evidence_attempt_id_work_attempt_id_fk\` FOREIGN KEY (\`attempt_id\`) REFERENCES \`work_attempt\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_goal\` (
          \`id\` text PRIMARY KEY,
          \`directory\` text NOT NULL,
          \`workspace_id\` text,
          \`objective\` text NOT NULL,
          \`acceptance_criteria\` text NOT NULL,
          \`role_contracts\` text DEFAULT '[]' NOT NULL,
          \`worker_id\` text,
          \`status\` text NOT NULL,
          \`budget\` text,
          \`usage\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_handoff\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`attempt_id\` text NOT NULL,
          \`producer\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`items\` text NOT NULL,
          \`evidence_ids\` text NOT NULL,
          \`recipients\` text DEFAULT '[]' NOT NULL,
          \`digest\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_work_handoff_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_handoff_task_id_work_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`work_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_handoff_attempt_id_work_attempt_id_fk\` FOREIGN KEY (\`attempt_id\`) REFERENCES \`work_attempt\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_lease\` (
          \`goal_id\` text PRIMARY KEY,
          \`owner_id\` text NOT NULL,
          \`controller_id\` text,
          \`controller_runtime_id\` text,
          \`worker_id\` text DEFAULT 'worker_local' NOT NULL,
          \`fence\` integer NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_work_lease_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_memory_resolution\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`workspace_id\` text,
          \`key\` text NOT NULL,
          \`handoff_id\` text NOT NULL,
          \`handoff_digest\` text NOT NULL,
          \`item_digest\` text NOT NULL,
          \`action\` text DEFAULT 'select' NOT NULL,
          \`value\` text,
          \`resolver\` text NOT NULL,
          \`reason\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_work_memory_resolution_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_memory_resolution_handoff_id_work_handoff_id_fk\` FOREIGN KEY (\`handoff_id\`) REFERENCES \`work_handoff\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_task\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`instructions\` text NOT NULL,
          \`depends_on\` text NOT NULL,
          \`role\` text NOT NULL,
          \`directory\` text,
          \`workspace_id\` text,
          \`status\` text NOT NULL,
          \`criteria\` text NOT NULL,
          \`attempt_count\` integer NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_work_task_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_worker_job_artifact\` (
          \`job_id\` text NOT NULL,
          \`digest\` text NOT NULL,
          \`worker_id\` text NOT NULL,
          \`fence\` integer NOT NULL,
          \`label\` text NOT NULL,
          \`reference\` text NOT NULL,
          \`size\` integer NOT NULL,
          \`media_type\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`work_worker_job_artifact_pk\` PRIMARY KEY(\`job_id\`, \`digest\`),
          CONSTRAINT \`fk_work_worker_job_artifact_job_id_work_worker_job_id_fk\` FOREIGN KEY (\`job_id\`) REFERENCES \`work_worker_job\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_worker_job_artifact_worker_id_work_worker_id_fk\` FOREIGN KEY (\`worker_id\`) REFERENCES \`work_worker\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_worker_job_log\` (
          \`job_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`worker_id\` text NOT NULL,
          \`fence\` integer NOT NULL,
          \`stream\` text NOT NULL,
          \`message\` text NOT NULL,
          \`size\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`work_worker_job_log_pk\` PRIMARY KEY(\`job_id\`, \`sequence\`),
          CONSTRAINT \`fk_work_worker_job_log_job_id_work_worker_job_id_fk\` FOREIGN KEY (\`job_id\`) REFERENCES \`work_worker_job\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_worker_job_log_worker_id_work_worker_id_fk\` FOREIGN KEY (\`worker_id\`) REFERENCES \`work_worker\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_worker_job_outbox\` (
          \`job_id\` text PRIMARY KEY,
          \`worker_id\` text NOT NULL,
          \`runtime_id\` text NOT NULL,
          \`fence\` integer NOT NULL,
          \`operation\` text NOT NULL,
          \`state\` text NOT NULL,
          \`result\` text,
          \`artifacts\` text DEFAULT '[]' NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_worker_job\` (
          \`id\` text PRIMARY KEY,
          \`worker_id\` text NOT NULL,
          \`goal_id\` text NOT NULL,
          \`attempt_id\` text NOT NULL,
          \`criterion_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`lease_runtime_id\` text,
          \`fence\` integer NOT NULL,
          \`operation\` text NOT NULL,
          \`result\` text,
          \`lease_expires_at\` integer,
          \`cancel_reason\` text,
          \`cancel_requested_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_work_worker_job_worker_id_work_worker_id_fk\` FOREIGN KEY (\`worker_id\`) REFERENCES \`work_worker\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_worker_job_goal_id_work_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`work_goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_work_worker_job_attempt_id_work_attempt_id_fk\` FOREIGN KEY (\`attempt_id\`) REFERENCES \`work_attempt\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_worker\` (
          \`id\` text PRIMARY KEY,
          \`label\` text NOT NULL,
          \`endpoint\` text,
          \`capabilities\` text NOT NULL,
          \`workspace_roots\` text NOT NULL,
          \`runtime_id\` text,
          \`capacity\` integer DEFAULT 1 NOT NULL,
          \`execution_mode\` text DEFAULT 'shared' NOT NULL,
          \`location_mappings\` text DEFAULT '[]' NOT NULL,
          \`draining\` integer DEFAULT false NOT NULL,
          \`credential_hash\` text,
          \`credential_created_at\` integer,
          \`credential_last_used_at\` integer,
          \`credential_revoked_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_heartbeat\` integer NOT NULL,
          \`expires_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`work_artifact_owner_owner_idx\` ON \`work_artifact_owner\` (\`owner_type\`,\`owner_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_artifact_accessed_idx\` ON \`work_artifact\` (\`time_collected\`,\`time_accessed\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`work_attempt_task_number_idx\` ON \`work_attempt\` (\`task_id\`,\`number\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_attempt_goal_status_created_idx\` ON \`work_attempt\` (\`goal_id\`,\`status\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`work_attempt_session_idx\` ON \`work_attempt\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`work_controller_dispatch_pending_idx\` ON \`work_controller_dispatch\` (\`processed_revision\`,\`revision\`,\`time_requested\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_controller_dispatch_lease_idx\` ON \`work_controller_dispatch\` (\`lease_expires_at\`);`,
      )
      yield* tx.run(`CREATE INDEX \`work_controller_expires_idx\` ON \`work_controller\` (\`expires_at\`);`)
      yield* tx.run(
        `CREATE INDEX \`work_evaluation_task_criterion_created_idx\` ON \`work_evaluation\` (\`task_id\`,\`criterion_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_evaluation_attempt_created_idx\` ON \`work_evaluation\` (\`attempt_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_evidence_attempt_created_idx\` ON \`work_evidence\` (\`attempt_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_evidence_task_created_idx\` ON \`work_evidence\` (\`task_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_goal_location_status_updated_idx\` ON \`work_goal\` (\`directory\`,\`workspace_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`work_handoff_task_idx\` ON \`work_handoff\` (\`task_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_handoff_attempt_idx\` ON \`work_handoff\` (\`attempt_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`work_handoff_goal_created_idx\` ON \`work_handoff\` (\`goal_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`work_lease_expires_idx\` ON \`work_lease\` (\`expires_at\`);`)
      yield* tx.run(
        `CREATE INDEX \`work_memory_resolution_location_key_created_idx\` ON \`work_memory_resolution\` (\`directory\`,\`workspace_id\`,\`key\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_memory_resolution_goal_created_idx\` ON \`work_memory_resolution\` (\`goal_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_task_goal_status_created_idx\` ON \`work_task\` (\`goal_id\`,\`status\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`work_task_status_updated_idx\` ON \`work_task\` (\`status\`,\`time_updated\`);`)
      yield* tx.run(
        `CREATE INDEX \`work_worker_job_artifact_created_idx\` ON \`work_worker_job_artifact\` (\`job_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_worker_job_log_created_idx\` ON \`work_worker_job_log\` (\`job_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_worker_job_outbox_state_updated_idx\` ON \`work_worker_job_outbox\` (\`state\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`work_worker_job_attempt_criterion_idx\` ON \`work_worker_job\` (\`attempt_id\`,\`criterion_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`work_worker_job_worker_status_created_idx\` ON \`work_worker_job\` (\`worker_id\`,\`status\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`work_worker_job_lease_expires_idx\` ON \`work_worker_job\` (\`lease_expires_at\`);`)
      yield* tx.run(`CREATE INDEX \`work_worker_expires_idx\` ON \`work_worker\` (\`expires_at\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
