# Backup and restore

*Operator-facing. Rehearsed 2026-11-12 on the synthetic Compose binding; see the status line and the
stop conditions in [README.md](README.md). Commands are the Compose binding's, through
[`../drills/stack.sh`](../drills/README.md).*

There are two different restores. Choose by what was lost.

| | tenant-local restore | whole-deployment recovery |
|---|---|---|
| restores | one tenant's clinical records, from that tenant's export artifact | the database, the Vault and the private state, from a cold backup |
| other tenants | keep working throughout; nothing of theirs changes | return to the backup instant with everyone else |
| history | moves **forward**: changed records get new server timestamps, records made after the export become deletion records, so a client that syncs incrementally converges | is **replaced**: clients that synced after the backup hold records the server no longer has |
| keys, credentials, access, settings | stay current; not taken from the artifact | return to the backup instant |
| needs | the tenant open, no unfinished operations, every cohort role healthy | every container stopped |

## A. Export one tenant (take the artifact)

1. Run the export for the tenant. In the binding this is the private operator service:
   `stack.sh ops demo node -r ./deploy/multitenant/load-env.js deploy/multitenant/restore.js export --tenant <tenant> --directory /run/ns-artifacts`
2. It prints the artifact's digest. The artifact is the directory `tenant-artifact-<digest>` in the
   private artifacts directory. Record the digest somewhere else; the restore needs it exactly.
3. The artifact holds clinical records and ciphertext. It does not hold keys. Treat it as health data.

An export does not close the tenant. If the export process dies, nothing is published and you run it
again (rehearsed: `drill-operation-death.sh export`). A directory named `.tenant-partial-*` is an
unfinished write, not an artifact: leave it for inspection and never rename it into place
(read-derived, `lib/tenant-lifecycle/filesystem-artifact.js:31`).

## B. Restore one tenant from its artifact

Tell the tenant's users first: the site is closed for the length of the restore.

1. **Pre-check.** `drills/precheck.sh <tenant>` must print `"start":true`. A request that is being
   served has an unfinished marker while it runs, so the pre-check re-reads a non-zero count for a
   few seconds; only a count that stays is a blocking condition. If it reports
   `UNFINISHED_OPERATIONS_PRESENT`, `TENANT_WINDOW_NOT_ACTIVE` or `PARTICIPANT_NOT_HEALTHY`, stop and
   follow [README.md](README.md#a-tenant-held-closed-by-an-interrupted-restore). The restore refuses by itself, with the tenant still
   open, when an unfinished operation's owner is gone; a restore that is interrupted after it closed
   the tenant leaves it closed until an operator resumes it.
2. **Restore.** `... restore.js restore --tenant <tenant> --directory /run/ns-artifacts --digest <digest>`.
   Success prints `"state":"restored-and-active"`. A refusal prints one line with an `error` code
   and the words "Do not automatically replay or reopen the tenant"; an unknown digest is `ENOENT`
   and closes nothing.
   A refusal that leaves the window `active` closed nothing. One such refusal is
   `RESTORE_COHORT_UNKNOWN_BACKEND`: a database session that is not one of the cohort's was present.
   Rehearsed twice: it happens for about a minute after provisioning activity and then clears (the
   attribution to the admin service's provisioning sessions is read-derived). Do not restore while
   tenants are being provisioned. If the refusal does not clear, find the session before doing
   anything else; an unknown session with data authority is a finding of its own.
3. **Verify state.** Read back, through the API, records you know were in the export: they have the
   exported values; records created after the export read as deleted.
4. **Verify history, separately.** Ask the history endpoint for everything after the last timestamp a
   client had seen before the restore. The reply must contain a correction for each changed record
   and a deletion record for each record made after the export. State being right does not show this.
5. **Verify the other tenants.** A record another tenant wrote before the restore is unchanged, and
   it can write a new one.
6. **Read the persisted state** ([README.md](README.md)): window `active` with no claim, audit `activated`.

Rehearsed by `drill-tenant-restore.sh`: both verifications fail when run before the restore; an
artifact whose content or name was changed is refused (`LIFECYCLE_ARTIFACT_DIGEST`) and the tenant
stays open.

If step 2 ends any other way, do not run it again. Read the persisted state and go to
[role-death-mid-operation.md](role-death-mid-operation.md) or [lost-acknowledgement.md](lost-acknowledgement.md).

What a tenant-local restore does not do (read-derived, `lib/tenant-lifecycle/README.md`): it does not
bring back access credentials, authorization, secrets, owner configuration, checkpoints or alarm
suppression from the artifact; it does not restore a tenant that was deleted and whose key retention
window has ended; it cannot create a tenant on a different deployment.

## C. Cold backup of the whole deployment

The backup is three things from the same instant, or it is nothing:

| part | why it cannot be left out |
|---|---|
| the PostgreSQL volume | every tenant's records, and the lifecycle state |
| the Vault volume | the keys the stored ciphertext names. A database without them cannot be read, and a new Vault will not be initialized in their place (rehearsed: refused, `BOOTSTRAP_VAULT_STATE_CHANGED`) |
| the private state directory | role credentials, the certificate authority, the Vault unseal material, export artifacts, lab client custody |

1. Tell users: the whole deployment is down for the length of the backup.
2. `stack.sh stop`. Confirm with `stack.sh ps` that nothing is running.
3. Optional but recommended: start PostgreSQL alone, run `drills/census.sh > census-at-backup.txt`,
   stop it again. The census is a count and digest per table; it is the independent state reference.
4. `drills/backup.sh <new-absolute-directory>`. It refuses a running deployment and an existing
   directory, and writes `manifest.json` with the source revision, deployment revision and a digest
   of each archive.
5. `stack.sh roles-up`. Confirm every role is healthy.
6. Move a copy off the host. The backup directory is as sensitive as the deployment: it contains the
   unseal material and every role credential. Its custody, encryption and retention are yours to decide.

## D. Whole-deployment recovery from a cold backup

For a planned change of application revision, use the explicit
[ordinary revision transition](interrupted-upgrade.md#explicit-ordinary-revision-transition).
Its rollback first checks the older catalogues and domain artifact in fresh namespaces, then
restores this complete paired cold backup before serving. The domain artifact alone does not
restore global registry authority, Vault keys or role credentials. Retain the upgraded original
and qualify the replacement on separate disposable resources.

**This returns every tenant to the backup instant.** Rehearsed: a record another tenant wrote after
the backup is gone afterwards (`drill-whole-deployment-recovery.sh`). A person accepts that before step 1.

1. Tell users. Stop whatever is still running: `stack.sh stop`.
2. Set the old state directory aside (rename it; do not delete it until the recovery is verified)
   and remove this deployment's volumes, or start from an empty host.
   `drills/recover-from-backup.sh <backup> --accept-loss-since-backup` does steps 2 to 5 in place.
3. `drills/restore-deployment.sh <backup>`. It checks every archive against the manifest, checks that
   the prepared source and deployment revisions are the backup's, and refuses to overwrite an
   existing volume or state directory. It starts nothing.
4. **Verify state before any role starts.** Start PostgreSQL alone, run `drills/census.sh`, and
   compare with the census taken at backup. They must be identical.
5. `stack.sh roles-up`. The first step unseals the Vault from the restored custody; then the roles
   start in order. Every role healthy.
6. **Verify history, separately.** The history reply for a tenant matches what it was at the backup.
7. Confirm every restored tenant is registered: the count of `active` rows in
   `<prefix>_registry.tenant_registry` is what it was at the backup, and no tenant has stored rows
   without a registry entry ([README.md](README.md), "Does a restore register the tenant?").
8. Read the persisted state for any tenant that was closed before: its window is as it was **at the
   backup instant**. A backup taken while a tenant was held closed restores it held closed.
9. Clients that synced between the backup and the recovery hold records the server no longer has.
   There is no rehearsed procedure that reconciles them; tell users what window was lost.

Rehearsed by `drill-host-replacement.sh`: an archive with one changed byte is refused before
anything is created; the database and state without the Vault volume are refused and no role starts;
the census matches after a correct restore and differs after one new write.

Not covered: an online backup, point-in-time recovery, a logical dump, restoring into a different
state path, and a backup older than the service credentials' lifetime (24 hours in the lab binding).
