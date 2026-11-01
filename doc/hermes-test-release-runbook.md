# Hermes test candidate: backup, deployment and rollback

This document is a procedure only. It does not authorize production access.
Do not execute production steps before explicit operator approval.

## Candidate identity and qualification

Use the `Fork Docker validation` run attached to the PR head. Download its
receipt artifact and inspect `source-commit.txt`, `image-reference.txt` and
`validation.txt`. The reference must be
`ghcr.io/robertoabee/paperclip-hermes-test@sha256:<64 hex characters>`.
Never substitute a mutable tag. The workflow publishes only after the exact
local image passes isolated health, empty-company, UI and restart checks.
Only linux/amd64 is qualified by this workflow.

The isolated qualification completed successfully on source commit
`5aeaffcfdf7c489322caeea20a091f5e2c7961ba`:

- Docker runtime smoke ran with `--network none`, tmpfs-only application data,
  no host mounts, named volumes, published ports, production data, provider
  credentials or live Hermes connection.
- The real application route reached a synthetic loopback Hermes Gateway with
  no managed provider binding, bypassed a stale router selection and redacted
  the synthetic key.
- The real Paperclip heartbeat route invoked the Hermes Gateway
  `POST /v1/runs` endpoint and completed through SSE; the synthetic key was
  not exposed in the heartbeat response.
- A synthetic recovery rehearsal backed up and restored a synthetic company,
  Hermes agent, heartbeat run and secret records into a separate disposable
  database.
- The recovery bundle checksum, local storage probe file and encrypted-secrets
  master-key file were verified after extraction into separate paths.
- Health, empty-company state, UI, image identity and restart checks passed.
- The tested image architecture is `linux/amd64` only.

These tests prove the isolated recovery and synthetic heartbeat path. They do
**not** prove a live production Hermes call or restore of the actual production
dataset. A production-data restore rehearsal and live gateway validation remain
separate approval-gated activities.

## Before requesting production approval

- Require green checks on the exact source commit and the Docker receipt.
- Verify host architecture independently; prepare a matching image if needed.
- Record the current image's registry digest, application version, Compose
  configuration and deployment settings through the operator's approved path.
- Determine whether the actual deployment uses embedded PostgreSQL or an
  external database. Do not assume that a volume archive covers both.
- Prepare a maintenance window and a tested restoration plan. Disable new runs
  and stop writers before the consistent snapshot. Avoid an archive of a live
  PostgreSQL data directory.
- Back up database, local file storage and required encryption/signing material
  as one recovery set. Encrypt the backup in the operator's backup system;
  never attach it to GitHub or to a build context. Preserve ownership/modes.
- For an external database use the matching PostgreSQL tools and verify the
  dump with pg_restore --list. For embedded PostgreSQL stop it cleanly before
  the filesystem snapshot. Confirm the selected backup method with the operator.
- Verify backup checksums and perform restoration into a NEW isolated data
  location with synthetic data first. Record recovery time and verification.
- Review pending schema migrations. An image rollback alone cannot undo schema
  changes. Do not automatically downgrade a migrated database.

## After explicit production approval only

1. Enter maintenance, stop task execution and writers, and create the verified
   recovery set immediately before replacement.
2. Pull the approved immutable digest and compare it with the CI receipt.
3. Change only the Paperclip image reference through the approved deployment
   path. Do not change Hermes Boss, shared infrastructure or other applications.
4. Start once; inspect migration/startup results, authentication, health, UI,
   company access and a controlled gateway test. Define the observation window
   and stop criteria before starting. Keep new task execution paused until
   the operator accepts verification.

## Rollback after approval

1. Stop new writes and the candidate. Preserve failure evidence without secrets.
2. If no schema/data change occurred, restore the previous immutable image.
3. If schema/data changed, restore the consistent pre-change recovery set into
   a new recovery location and pair it with the previous image. Verify the
   restored database and storage before routing traffic. Do not overwrite the
   failed state until the operator accepts the recovery.
4. Verify login, health, UI, company records, encryption access and gateway
   behavior. Re-enable work only after operator acceptance.

No production backup, restore, deployment or rollback was executed as part of
this development task. In particular, paperclip_data was not accessed.
