# Interrupted bootstrap, and a changed source revision

*Operator-facing. Rehearsed 2026-11-12 on the synthetic Compose binding; see the status line and the
stop conditions in [README.md](README.md).*

The bootstrap is the one step that creates database roles and schemas, runs the migrations, sets
grants and prepares the Vault. It runs once per deployment and records the exact source and
deployment revisions it ran for.

## Explicit ordinary revision transition

Use a stopped, paired cold backup to recover the complete deployment. The PostgreSQL
volume, Vault storage, private state and deployment settings must come from the same
point. Follow the [cold backup and restore procedure](backup-and-restore.md).
Record the image ID, source and deploy commits and the backup location before migrating.

For the private ordinary revision tool, `ordinary-single` selects one instance per role.
The private JSON plan names the exact source and target overlays, paired backup directory,
project, state directory, PostgreSQL identity and stopped application container IDs. Run
`node operator/revision-transition.js preflight /absolute/private-plan.json` to check both
source catalogues. Stop all application roles, keep their automatic restart disabled and
verify the complete cold backup before starting PostgreSQL and Vault alone.

`upgrade` applies the target migrations and records the source and target catalogue ledgers.
`activate` checks the target ledgers, image and supported configuration transition before
binding that target to the stopped state. Use ordinary role startup and check isolation,
readiness and a fresh clinical write. Interruptions leave effects stopped. Inspect the
private progress markers and recover from the original cold backup when the outcome is
uncertain. `rollback` identifies that backup for the platform restore procedure.

## The bootstrap was killed part-way

Signs: `bootstrap/started.json` exists in the private state directory, `bootstrap/complete.json`
does not; a new run prints `BOOTSTRAP_PARTIAL_RECREATE_DEMO`.

1. Do not start any role. None has credentials: they are written only at the end of a complete run
   (rehearsed: no role credentials exist and the admin service does not start).
2. Do not remove `started.json` to get past the refusal. The run then refuses on the leftover
   database objects instead (`BOOTSTRAP_OBJECTS_ALREADY_EXIST`, rehearsed), and if you removed those
   too you would be adopting a half-prepared Vault.
3. Decide which case you are in:
   - **A new deployment that never served.** Recreate it: remove this deployment's volumes, set its
     state directory and its `.env` aside, prepare again, bootstrap again. Rehearsed; the second run
     completes (`synthetic-infrastructure-ready`).
   - **A deployment that had data.** A bootstrap never runs against one in normal operation (it
     refuses or only unseals). If you are here, something else already went wrong: stop, keep
     everything, and recover from the last cold backup ([backup-and-restore.md](backup-and-restore.md), part D).

## A different image was started by mistake

The Compose wrapper checks the image's recorded source and deployment revisions against the prepared
deployment before bootstrap and start (`build.js --check-image`; read-derived). What a role built from
another revision does if it is started directly against this deployment's database is `UNMEASURED`.
If it happened: stop that role, read its log, read the persisted state of every tenant, and do not
assume nothing was written.
