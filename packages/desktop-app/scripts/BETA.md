# Windows Beta delivery

The windows-beta workflow builds an artifact only after the exact main SHA has successful test and typecheck runs. It uses beta channel, signed NSIS x64 output, packaged electron-updater, and an increasing 0.1.0-beta.<workflow-run-number> version. A failed workflow accepted under a separate audit exception is not treated as successful by this automatic gate.

Upload is a separate manual dispatch: provide the reviewed SHA, successful build run ID, and evaluator approval reference. The beta-publish GitHub environment must require the evaluator named by BETA_APPROVER_LOGIN, with self-review prevented. The workflow verifies that protection before uploading. Configure bucket-scoped R2_UPDATES_ACCESS_KEY_ID and R2_UPDATES_SECRET_ACCESS_KEY secrets there, restricted to zaovra-updates object read/write/delete. Existing Azure signing secrets and WINDOWS_SIGNING_PUBLISHER_NAME are reused. No credential belongs in source or release notes.

The default beta-release.ts operation is an offline dry run. Publishing requires --publish plus BETA_APPROVED_SHA and BETA_APPROVAL_REF. It validates installer size/SHA512 and Windows publisher signature, uploads immutable beta/<version>/ files, re-reads their hashes, then commits beta/beta.yml with no-store metadata. Only after that does it retain five versions listed in its own beta/versions.json index. Other bucket prefixes are never pruned. Interrupted unreferenced uploads are not advertised; review them before any manual cleanup.

Before quitAndInstall, the main process performs a SQLite online backup into the app userData/update-backups directory and runs quick_check. Committed WAL pages are included while the writer remains open. A backup error blocks the installer. A missing database or :memory: database has nothing to back up. Backups remain local and are never uploaded.

The first real Beta upload still requires the evaluator's explicit confirmation of the concrete artifact. No upload is implied by a local test or source commit.
