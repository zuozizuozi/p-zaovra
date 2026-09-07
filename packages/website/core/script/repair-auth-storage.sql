-- Matches src/schema/auth-storage.sql.ts. Apply to the website database
-- configured by DATABASE_URL only after confirming the production target.
-- Applied to the verified website production database; column verification
-- and POST /auth/device/code returned successfully after the repair.
BEGIN;

CREATE TABLE IF NOT EXISTS "openauth_storage" (
  "key" text PRIMARY KEY,
  "value" jsonb NOT NULL,
  "expiry" timestamp with time zone
);

COMMIT;
