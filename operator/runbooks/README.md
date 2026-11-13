# Recovery runbooks

*Operator-facing. Rehearsed 2026-11-12 on the synthetic Compose binding (core `debcc2c7`, binding
`2e9afbb`); every step marked **rehearsed** has a drill in [`../drills/`](../drills/README.md), and
every step marked **read-derived** comes from reading the source and has not been run. A deployment
with real data needs its own rehearsal on its own backups, custody and hosts before these are relied on.*

Nightscout is a secondary display for CGM and pump data. While a site is closed or unavailable, the
people who use it see no current data from it. Tell them, in plain words, to rely on their CGM's or
pump's own display and alarms until the site is back. Do that before starting any step below that
closes a tenant or stops the deployment.

| situation | runbook |
|---|---|
| take a backup; restore one tenant; restore the whole deployment | [backup-and-restore.md](backup-and-restore.md) |
| the bootstrap was killed part-way; a new source or deployment revision is offered to an existing deployment | [interrupted-upgrade.md](interrupted-upgrade.md) |
| a process died during provisioning, export, ownership change or restore | [role-death-mid-operation.md](role-death-mid-operation.md) |
| a reply never arrived and the outcome is unknown | [lost-acknowledgement.md](lost-acknowledgement.md) |
| PostgreSQL, Vault, one role or the host was restarted or replaced | [host-and-dependency-replacement.md](host-and-dependency-replacement.md) |

## Words used here

- **Tenant**: one Nightscout site inside the multitenant deployment. Each tenant has a stable
  identifier (a UUID); public names point at it.
- **Held closed**: the tenant's lifecycle window is `suspended`. Its requests and sockets are refused
  and its evaluator and realtime output stay empty. Other tenants keep working.
- **Cohort**: the fixed set of role processes (API, realtime, evaluator, tenant-admin) that must each
  acknowledge a tenant restore.
- **Unfinished operation**: a durable marker a role writes when it starts work for a tenant and
  finishes when the work completes. A role that is killed leaves its markers unfinished.
- **Cold backup**: a copy taken with every container stopped.

## Reading the persisted state

Every runbook starts and ends here. These are read-only, run as the database administrator inside the
PostgreSQL container (`drills/stack.sh compose exec -T postgres psql -U postgres -d nightscout_compose_test`).
`<prefix>` is the deployment's schema prefix (`nsdemo` in the synthetic binding).

```sql
-- Is the tenant open? phase is 'active' or 'suspended'; a claim and digest mean a restore owns it.
SELECT tenant_id, phase, generation, claim_id IS NOT NULL AS claimed, artifact_digest
  FROM <prefix>_control.tenant_lifecycle_windows WHERE tenant_id = '<tenant>';
-- How far did the last restore get? suspended -> restored -> activated
SELECT claim_id, generation, state, started_at, restored_at, activated_at
  FROM <prefix>_control.tenant_lifecycle_restore_audit WHERE tenant_id = '<tenant>' ORDER BY started_at DESC LIMIT 3;
-- Work that never reported finishing, and that no operator has cleared.
SELECT count(*) FROM <prefix>_control.tenant_lifecycle_operations o WHERE tenant_id = '<tenant>' AND NOT finished
   AND NOT EXISTS (SELECT 1 FROM <prefix>_control.tenant_lifecycle_operation_clearance c WHERE c.operation_id = o.operation_id);
-- Was a closed tenant reopened by an operator? before-data or data-replaced, one row per restore claim.
SELECT claim_id, interrupted, resumed_at FROM <prefix>_control.tenant_lifecycle_restore_resume WHERE tenant_id = '<tenant>';
-- Is the tenant admitted at all?
SELECT tenant_id, state FROM <prefix>_registry.tenant_registry WHERE tenant_id = '<tenant>';
```

`drills/precheck.sh <tenant>` reads the same facts and says whether a tenant-local restore may be started.

| audit state | window | meaning |
|---|---|---|
| `activated` | `active` | the last restore finished; the tenant is open |
| `suspended` | `suspended` | the tenant was closed, and the restored rows were **not** committed; stored data is as it was before the restore |
| `restored` | `suspended` | the restored rows **are** committed, and the tenant was never reopened |
| (no row, or an older `activated`) | `active` | no restore is in progress |

## Stop conditions

At each of these the procedure ends and a person decides. They are the same on every runbook.

1. **A tenant is held closed and no restore is running.** With a core that has the operator's
   `resume` (core branch `claude/restore-resume-20261113`; core `debcc2c7` does not have it), follow
   "A tenant held closed by an interrupted restore" below. Stop, and take the persisted state to the
   maintainers, when `inspect` does not say `"resumable":true`, when `resume` is refused, or when the
   core has no `resume`. It stays closed after waiting, after a second restore attempt (refused,
   `LIFECYCLE_RESTORE_ALREADY_SUSPENDED`) and after a role restart (rehearsed).
   **Never** update the window row, delete an audit or operation row, or change the claim by hand:
   the stored rows may be half of what you think they are, and every role caches what it last proved.
2. **Unfinished operations exist for a tenant.** Never clear them by hand. A restore started on
   that tenant refuses before it closes the tenant
   (`LIFECYCLE_RESTORE_PREFLIGHT_ORPHANED_OPERATIONS`) when a record's owner is gone; the tenant
   keeps serving (rehearsed). `clear-operations`, below, records the ones whose owner is provably
   gone. Stop when it reports any record as `retained`: something may still be running it.
3. **A restore ended with `LIFECYCLE_RESTORE_SUSPENSION_OUTCOME_UNCERTAIN`,
   `..._DATA_OUTCOME_UNCERTAIN` or `..._ACTIVATION_OUTCOME_UNCERTAIN`.** The reply to a commit was
   lost; the commit may or may not have happened. Read the persisted state above; do not run the
   restore again, and do not report the tenant as closed or open until you have read it. Read-derived
   (`lib/tenant-lifecycle/maintenance-window.js:193`); not rehearsed.
4. **A tenant is admitted and nobody holds its root secret** (the reply to its provisioning was
   lost). The retry is refused rather than issuing a second secret. Rehearsed. Removing or reissuing
   is a decision for the deployment's owner; neither is rehearsed here (see "Decided, and not yet in
   this source" below).
5. **The bootstrap reports `BOOTSTRAP_PARTIAL_RECREATE_DEMO`, `BOOTSTRAP_OBJECTS_ALREADY_EXIST`,
   `BOOTSTRAP_VAULT_STATE_CHANGED` or `BOOTSTRAP_VAULT_CUSTODY_MISSING`.** Nothing partial is adopted.
   Never remove a marker file to get past it. Rehearsed (the first three).
6. **The backup is not a complete unit** (database, Vault and private state from the same instant),
   or its digests do not match its manifest. Do not start a deployment from it. Rehearsed.

## A tenant held closed by an interrupted restore

Rehearsed 2026-11-13 on the synthetic Compose binding with core branch `claude/restore-resume-20261113`
(`drills/drill-restore-resume.sh`, four interruption kinds; `drills/drill-orphaned-operations.sh`).
The three commands run in the private operator container, like `restore`:

```bash
drills/stack.sh ops demo node -r ./deploy/multitenant/load-env.js deploy/multitenant/restore.js inspect --tenant <tenant>
drills/stack.sh ops demo node -r ./deploy/multitenant/load-env.js deploy/multitenant/restore.js resume --tenant <tenant> --claim <claimId from inspect>
drills/stack.sh ops demo node -r ./deploy/multitenant/load-env.js deploy/multitenant/restore.js clear-operations --tenant <tenant>
```

1. Tell the tenant's users it is closed and to rely on their CGM's or pump's own display and alarms.
2. Make sure the restore that closed it has ended (its operator container has exited) and every role
   is running and healthy. A resume asks every role to answer; with one role down it is refused and
   nothing changes.
3. `inspect`. It changes nothing. Read `interrupted`:
   - `before-data`: the tenant was closed and the restored rows were **not** stored. After a resume
     the tenant serves the data it had before the restore was started. The restore did not happen;
     start it again afterwards if it is still wanted.
   - `data-replaced`: the restored rows **are** stored. After a resume the tenant serves the
     restored data. Verify state and history as in [backup-and-restore.md](backup-and-restore.md).
   If `resumable` is `false`, read `reasons` and stop. `LIFECYCLE_RESUME_RESTORE_OWNER_PRESENT`
   means the restore is still running: wait for it. `LIFECYCLE_RESUME_PENDING_OPERATIONS` means
   unfinished operations must be cleared first (step 4).
4. Only when asked to by step 3 or by a refused restore: `clear-operations`. It records, for each
   unfinished operation whose owning process is provably gone, that nothing is running it. It never
   deletes or edits an operation record. If it lists any operation under `retained`, stop: a process
   may still be running it.
5. `resume --claim <claimId>`, with the claim `inspect` printed. A refusal leaves the tenant closed
   and changes nothing; read the code and stop.
6. Read the persisted state again: the window is `active`, the restore audit row is unchanged, and
   `<prefix>_control.tenant_lifecycle_restore_resume` has one row for the claim. Check the tenant
   answers, then tell its users.

Other tenants are not touched by any of these steps: in the rehearsal the other tenant wrote while
the first was closed and those records were still there after the resume.

When a resume is refused and cannot be made to pass, the remaining way out is the whole-deployment
recovery in [backup-and-restore.md](backup-and-restore.md). It returns **every** tenant to the backup
instant: everything any tenant wrote after the backup is gone. That trade is the decision; the
runbook does not make it for you. The other choice is to leave the one tenant closed, tell its
users, and take the persisted state (the queries above, role logs, the artifact digest) to the
maintainers.

## Decided, and not yet in this source

Two maintainer decisions of 2026-11-12 change what an operator will be able to do. Neither is in core
`debcc2c7` or this binding, so no step in these runbooks uses them and nothing here rehearses them.
The decisions live in the alignment workspace, `releases/cgm-remote-monitor-16.0.0/decisions.md`.

- **`tenant-ensure-and-factory-reset`.** Two operator operations. `ensure` (create or repair)
  recreates what is missing when no stored data depends on it, and refuses when data is encrypted
  under a missing key: the key comes back from a backup, never from a new key. `factory reset` returns
  a tenant's operational and configuration state to the deployment defaults; it never erases clinical
  data, and so it keeps the keys that protect that data. For these runbooks: a missing key is still
  recovered only from the Vault part of a cold backup, and stop condition 4 is where `ensure` or
  `factory reset` would be the supported answer once they exist. Whether either reissues a lost root
  secret is not decided; until it is, stop condition 4 stands as written. Reopening a tenant held
  closed and clearing unfinished operations are the operator's `resume` and `clear-operations`
  (decision `restore-resume-and-precheck`), not factory reset.
- **`realtime-automatic-recovery`.** Realtime workers restart on failure and keep their shards; a
  surviving worker takes over after a grace period. In this binding every role still has
  `restart: "no"` (`bindings/compose/multitenant/compose.yaml:11`), so today the operator restarts a
  dead role. An automatic restart does not change the restore rules: a restarted worker is a new
  incarnation, so a tenant restore that was in flight when it died is still refused and the tenant is
  still held closed (rehearsed with a manual restart: `drill-restore-interruption.sh participant-death`).
  It also does not cover the PostgreSQL case in
  [host-and-dependency-replacement.md](host-and-dependency-replacement.md), where the role does not
  die: it stays up and refuses.

## Does a restore register the tenant?

A tenant that has stored rows and no registry entry cannot be resolved by any role, and operator
operations on it are refused. A restore is therefore not finished until every tenant it restored has
a registry entry.

- **Whole-deployment recovery** (rehearsed): the registry is part of the database backup and comes
  back with the data. The drill checks that the count of registered tenants equals the count at
  backup and that no tenant has stored rows without a registry entry.
- **Tenant-local restore** (rehearsed): it requires the tenant to be registered and active before it
  starts (`drills/precheck.sh`), restores clinical records only, and neither writes nor needs to
  write a registry entry.
- **A restore into a new deployment** (not an operator command at core `debcc2c7`; `UNMEASURED`):
  nothing registers the restored tenants. The position these runbooks take is that such a restore
  should **end by registering each restored tenant through the operator's `ensure` operation**, with
  the restore reporting itself unfinished until that has succeeded, rather than the restore writing
  registry rows itself: `ensure` is the one place that decides whether the tenant's keys are present,
  and it refuses when stored data is encrypted under a key that is missing. This is recorded as an
  open question for the maintainer, not as a decision.

## What is not covered

Each of these is `UNMEASURED` here: an in-place upgrade or rollback of an existing deployment; an
online (hot) backup or point-in-time recovery; a restore across hosts with a different state path or
a different Vault; expired or revoked service credentials (the lab binding's Vault tokens last 24
hours and are not renewed; the Vault Agent binding is the renewing path); realtime worker placement
moves; more than one API instance; a tenant under real load; recovery time as a bound.
