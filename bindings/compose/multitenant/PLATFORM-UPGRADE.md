# Platform upgrades

Platform verification and the tenant floor proofs are retired (decision
`platform-verification-removal`). A role is ready when the migration ledger is current and its
own login cannot bypass row-level security (`/healthz/ready` on the role's private listener).
Floors are written inside the provisioning, restore and migration transactions.

## Upgrade existing evaluator and realtime recovery state

For an existing ordinary deployment, stop writers and serving roles before the recovery schema
upgrade. Use the elevated migration connection and the generated evaluator and realtime role
configurations from that deployment. Fresh bootstrap runs the same migration catalogues and grants.

1. Obtain `layout` and `catalogues` from the selected deployment's
   `deploy/multitenant/config.js`. For each of `eval_checkpoint`, `outbox` and `rt_checkpoint`,
   call the selected core's `lib/migrations/postgres.run('up', { direct: true, connectionString,
   namespace: layout.namespaces[kind], catalogue: catalogues[kind] })`. This appends the
   evaluator pending marker and notification schedule functions/indexes, and applies the
   realtime receipt removal below. The migration ledger checks prior checksums.
2. Run the SQL from `lib/server/ordinary-deployment-grants.notificationScheduleGrants` with
   `namespace: layout.namespaces.outbox`, `owner: layout.owner`,
   `outboxRole: layout.roles.outbox` and `ackRole: layout.roles.alarm`. The outbox tables
   must already belong to the deployment's non-login schema owner. Grant the evaluator
   `UPDATE` on the columns in `lib/pgstream/checkpoint.WORK_COLUMNS` on its
   `tenant_consumer_checkpoint` relation, as in `deploy/multitenant/output-grants.js`.
3. Restart the roles with the new role files. Record the migration checksums.

## Realtime receipt removal (core migration `0004_realtime_receipt_removed`)

The old realtime build writes a delivery receipt. The new build reads the evaluator's
completed output and requires a current migration ledger and a read-only checkpoint
role. Clients lose live updates during the stop and reconnect when realtime starts.

Keep all old realtime workers stopped until bootstrap succeeds. Use the same database,
private credential seed and bootstrap state throughout the upgrade.

- **Compose.** Stop every realtime service in the prepared project, including numbered
  workers. For a prepared fixture, stop all application roles before using
  `demo.sh patch` with its existing private environment file and the new image.
  The patch command checks the image and fixture, runs bootstrap and starts the
  new roles in dependency order.
- **Kubernetes.** Scale the realtime StatefulSet to zero and wait until its pods have
  terminated. Keep it at zero while recreating and running the new provision Job
  against the existing state volume. After the Job completes, apply the new
  StatefulSet template and restore the configured replica count.

Migration `0004_realtime_receipt_removed` removes the obligation function and
its checkpoint triggers, the owed index, and the receipt columns with their column
grants. Use the existing elevated bootstrap connection with authority to drop
those objects. On an existing database, bootstrap then drops the retired delivery
UPDATE policy. Fresh bootstrap installs the realtime SELECT grants and policies.
Confirm the new roles pass their private readiness checks.

The migration waits up to five seconds to acquire each required table lock. If it
times out, the receipt-removal transaction rolls back. Keep realtime stopped,
resolve the blocking transaction and rerun bootstrap.

## Enable owner display editing on an existing deployment

The regular Compose `up` or `bootstrap` action extends an existing private credential seed
with one password for `owner_settings`. The existing-database bootstrap creates the missing
login and applies its grants. Only tenant-admin receives its connection file. Other role
passwords and the tenant settings rows remain in place.

On an existing Kubernetes deployment, add the same two fields that a fresh offline seed
produces. In private operator custody generate a new 32-byte hex password for the
`owner_settings` field in `ns-credentials-postgres`. Use the ordinary renderer with that seed
and the same PostgreSQL host and database to produce `tenant-admin/ns_owner_settings_pg`.
Merge this one file into `ns-config-tenant-admin` and retain both existing Secrets' other
fields. Rerun the provision Job with its existing state volume, then restart tenant-admin.
Use the original private seed or other operator custody for existing credentials.

The private operator's next add, transfer or recovery assigns configure to a newly assigned
owner. For a tenant with a pre-upgrade owner, list its current owners and repeat the private
ownership add for the selected principal and management consumer, supplying the returned
expected owner list and its intended delegation. This initializes only a missing configure
row. An existing inactive row or explicit denial remains in place, including after a former
owner is reassigned. Owner settings requests use the resulting owner's management session.
