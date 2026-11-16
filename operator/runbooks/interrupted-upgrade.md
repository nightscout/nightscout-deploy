# Interrupted bootstrap, and a changed source revision

*Operator-facing. Rehearsed 2026-11-12 on the synthetic Compose binding; see the status line and the
stop conditions in [README.md](README.md).*

The bootstrap is the one step that creates database roles and schemas, runs the migrations, sets
grants and prepares the Vault. It runs once per deployment and records the exact source and
deployment revisions it ran for.

## Explicit ordinary revision transition

`node operator/revision-transition.js <preflight|upgrade|activate|rollback> <private-plan.json>`
composes the admitted core deployment operations. It never starts a role. Bootstrap still refuses
an implicit source change (`BOOTSTRAP_SOURCE_CHANGED_RECREATE_DEMO`). Only the explicit recorded
`activate` operation updates the prepared target environment and bootstrap source binding after
the admitted upgrade checks succeed. A started operation is never automatically replayed:
`REVISION_INTERRUPTED_OR_ALREADY_RUN` means keep effects stopped and inspect the original records,
artifact and namespaces. Do not delete its marker to retry uncertain DDL.

The rehearsed pair is core `d7a7ff4d513abf364622582f5f2a9147936a6d48` / deployment
`467c804fd459a382bdb0133f552a6d8827614760` to core
`5e112547b31252ec428747c821d3cd1b3684ce2b` / deployment
`460666c0c90ca649edfcf4413c5a911700e03768`. Its six `0100_*_storage_identity` migrations
enable full replica identity: subsequent WAL updates carry the old row needed by raw clients.
The ordinary single API/evaluator/realtime profile retains the same configuration generators.
Selected admission, multiple instances and changed configuration generators are refused by this
procedure. Other revision pairs require their own compatibility qualification. In particular,
the earlier `543808784e0f5f03945b840142a0df31177443ba` archive refuses `MIG_OPERATION_SQL`;
do not rewrite that archive or substitute current SQL for its history.

### Private plan and custody

Keep the plan and all artifacts outside Git, mode `0600`, in a private directory. The version-1
plan contains `profile: "ordinary-single"`, the exact prepared Compose project (validated by the
binding's existing project grammar, including its ordinary default), absolute
`directory` (operation records), `coldBackup`, `state`, `source` and `target`. Each source descriptor
contains its absolute clean overlaid core `root`, full `sourceCommit` and `deployCommit`; target
also contains its immutable `image` ID. `database` names the actual `name`, `oid` and
`systemIdentifier`. `cohort` lists every existing non-infrastructure container's exact `id` and
immutable `image`. `rollbackNamespaces` maps every admitted kind to a distinct fresh namespace.
Obtain these expectations from actual Git, image, Docker and database inspection. The command
rechecks them. Supply the direct DBA connection only through `NS_REVISION_PG`.

The outer cold backup is mandatory: PostgreSQL, Vault and private state are one custody unit.
The admitted domain artifact contains ciphertext and tenant/control tables; it does not contain
global registry state or Vault keys. Do not treat it as a replacement for the paired cold backup.
Keep exclusive platform/DBA custody and external writers excluded throughout the transition.

### Upgrade and deliberate reopen

1. Tell users the site will be unavailable, using the safety guidance in [README.md](README.md).
   On the disposable rehearsal, `drill-revision-transition.sh seed` populates both tenants through
   the API. `viewer` checks authorized HTTP and actual stock WebSocket frames.
2. Run `preflight`. Both exact source archives must pass the current source census. Record original
   restart policies, disable automatic restart, stop the complete project and take the paired
   [cold backup](backup-and-restore.md#c-cold-backup-of-the-whole-deployment).
3. Start PostgreSQL and Vault alone. Bind the exact stopped application cohort and backend in the
   private plan. Run `upgrade`. It performs status, durable source backup, migration up, check and
   source-column preservation. Keep `upgrade-started.json`, `upgrade-record.json` and its artifact.
4. Run `activate`. It requires the same configuration generators, completed target ledgers,
   exact target image labels and original source/state/project bindings. It changes the target
   preparation explicitly; it does not invoke bootstrap to adopt an unknown deployment.
5. Prepare the target containers **without starting application roles**. `stack.sh compose create
   --force-recreate admin api realtime evaluator pgstream tenant-admin ui nginx` uses the installed
   Compose command; `create` has no `--no-deps` option. Start only PostgreSQL/Vault, disable application
   restart, and capture the new exact cohort. All containers must have the target preparation's
   actual Compose lineage; preserve the earlier inspection rather than relabelling it.
6. Replace the pre-identity slot through the explicit `replace-revision` action described below.
   Start only evaluator and pgstream by exact CID. `drill-revision-transition.sh verify` compares
   current physical clocks, accepted input, completed work, pending state, restore generation and
   independently written clinical content. Compare pre-backup due instants with completion: due
   work must complete without another upload; a later genuine due may remain. A RAM generation,
   acquisition label or TIME counter is not this evidence.
7. Unseal the existing Vault through the target bootstrap, then deliberately start the private API.
   Wait for read-only health before `drill-revision-transition.sh write`; this makes a further
   supported write. Require `verify`, then start the exact realtime/ingress client path and require
   `viewer`. Restore original restart policies before deliberate starts. Reopen the remaining
   serving roles only after these checks. A healthy container alone is insufficient.

### The planned WAL boundary

A preserved valid slot can contain WAL encoded **before** full replica identity. In the actual
rehearsal the current receiver refused that old primary-key-only update with HTTP 503; strict
pgstream stopped and the new physical write remained ahead of durable input/completion. Merely
running the migration did not qualify transport continuity. The original failure is retained.

The existing [host helper](../../bindings/compose/multitenant/PGSTREAM-REBOOTSTRAP.md) now accepts
`action: "replace-revision"` for the exact pair above. Keep all its existing source/image, complete
stopped-cohort, no-writer/backend, least-grant, subscription, configuration and Compose-hash
requirements. Install the host helper in its separately attributed current-core operator context;
do not change the running image or frozen source worktree to install it.

Its additional `revision` object names absolute `planFile`, `upgradeRecord`, `coldManifest` and
`startedRecord` paths, with SHA256 of their exact bytes as `planSha256`, `recordSha256`,
`coldSha256` and `startedSha256`. Use the original sealed upgrade plan, not a later cohort plan.
The helper verifies the admitted old/current catalogues and namespace mapping, all six identity
appends, current full identities and ledgers, artifact digest, all four cold archives and both
images. A durable `revision-slot-started.json` prevents replay with a different receipt path.
Interruption keeps the deployment stopped; it does not authorize an automatic slot retry.

This operation deliberately replaces old WAL coverage with reconstruction from the current stopped
physical source. It neither clears checkpoints nor claims clinical completion. The independent
input/completion/due/current-authority and subsequent new-write/client checks remain necessary.
`create-missing` and `replace-lost` continue to refuse an ordinary valid slot.

### Backup-based rollback

Stop the exact current cohort and keep the upgraded namespaces and captures. With a new explicit
current cohort in the private plan, run `rollback`. Core checks that the older binary refuses the
upgraded catalogues, restores the verified pre-upgrade domain artifact into fresh namespaces, and
checks the older catalogues there. It never runs a down migration or decrements a migration ledger.
Its record names the loss boundary: writes after the backup instant are absent.

Before old serving resumes, restore the complete paired cold backup into an empty deployment with
the predecessor's exact source/image, using [whole-deployment recovery](backup-and-restore.md).
This restores global authority, registry, keys and credentials together. Preserve the upgraded
original project; use separate project, port and network ranges for the replacement rehearsal.
Compare census and both tenants' authorized content to the backup, including the deliberate
post-backup write loss. A domain-only fresh-namespace restore does not authorize serving.

### Reproduced scope and retained evidence

The `revision-transition-20261116` local two-tenant rehearsal retains originals under
`/tmp/ns-revision-transition-20261116`. Upgrade/source preservation, old-binary refusal and fresh
domain rollback, full paired-backup replacement and authorized old/current API/WebSocket content
were exercised. The old-WAL 503 and first failed new-input convergence remain failures of the
unqualified preserved-slot path, not failures relabelled as passes. The planned replacement and
subsequent physical/input/completed/due proof qualify the explicit path above. Raw captures,
credentials, database archives and synthetic traces are private and untracked.

Final affected controls: **38 passed** in installed core context, including ordinary valid-slot
refusal, complete cohort/image bindings, changed archive refusal, interrupted-operation replay,
current-content/restore/clock controls and single-use revision-slot custody. The actual stopped
deployment also refused a changed upgrade-record hash and deliberately broken full identity;
the slot position stayed unchanged, full identity was restored, and the positive operation passed.
The final helper SHA256 was
`d668f50c6aa30013133ba8dce91f872ab665721c1727b7b0c2b9a3d51753a5c0`.
Retained originals include `revision-negative-controls.log`, `slot-revision-receipt-final.json`,
`final-reopen.log` (durable work/new-write checks plus the initial viewer startup refusal),
`final-reopen-viewer02.log` (authorized frames after readiness), `rollback-viewer.log`, and both
`cold-backup/` and `cold-upgraded-final/`. Both exact projects' containers, networks and volumes
were independently absent after cleanup; ports 20880 and 20881 were free. No shared run was changed.

This is one ordinary single-host revision pair, not HA, provider delivery exactly-once, an online
upgrade, a revision matrix or evidence for an entered capacity run. Runtime integration owns the
future joined candidate and its acceptance; this helper leaf does not alter ongoing runs.

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
