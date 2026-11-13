# Interrupted bootstrap, and a changed source revision

*Operator-facing. Rehearsed 2026-11-12 on the synthetic Compose binding; see the status line and the
stop conditions in [README.md](README.md).*

The bootstrap is the one step that creates database roles and schemas, runs the migrations, sets
grants and prepares the Vault. It runs once per deployment and records the exact source and
deployment revisions it ran for.

## What exists today

At core `debcc2c7` and this binding there is **no in-place upgrade** of an existing deployment. A
bootstrap offered a different source or deployment revision refuses
(`BOOTSTRAP_SOURCE_CHANGED_RECREATE_DEMO`) and changes nothing; the same revision is accepted and only
unseals the Vault (rehearsed: `drill-interrupted-bootstrap.sh source-change`). Core carries a
whole-deployment upgrade and rollback library (`lib/tenant-operations`), with no command wired to it
and no rehearsal here. Until that exists as an operator command, moving a deployment with data to a
new revision is not a supported procedure; do not improvise one on real data.

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
