# Platform upgrades

Platform verification and the tenant floor proofs are retired (decision
`platform-verification-removal`). A role is ready when the migration ledger is current and its
own login cannot bypass row-level security (`/healthz/ready` on the role's private listener).
Floors are written inside the provisioning, restore and migration transactions.

## Upgrade existing evaluator and realtime recovery state

For an existing ordinary deployment, stop writers and serving roles before the recovery schema
upgrade. Use the elevated migration connection and the generated evaluator and realtime role
configurations from that deployment. Fresh bootstrap runs the same migration catalogues, grants
and realtime binding during pgstream setup.

1. Obtain `layout` and `catalogues` from the selected deployment's
   `deploy/multitenant/config.js`. For each of `eval_checkpoint`, `outbox` and `rt_checkpoint`,
   call the selected core's `lib/migrations/postgres.run('up', { direct: true, connectionString,
   namespace: layout.namespaces[kind], catalogue: catalogues[kind] })`. This appends the
   evaluator pending marker, notification schedule functions/indexes, and realtime obligation
   columns/index. The migration ledger checks prior checksums.
2. Run the SQL from `lib/server/ordinary-deployment-grants.notificationScheduleGrants` with
   `namespace: layout.namespaces.outbox`, `owner: layout.owner`,
   `outboxRole: layout.roles.outbox` and `ackRole: layout.roles.alarm`. The outbox tables
   must already belong to the deployment's non-login schema owner. Grant the evaluator
   `UPDATE` on the columns in `lib/pgstream/checkpoint.WORK_COLUMNS` on its
   `tenant_consumer_checkpoint` relation, as in `deploy/multitenant/pgstream.js`.
3. On the existing DBA client, call `lib/pgstream/realtime-obligation.install(client,
   { source, target, producer, consumers })` once for the unbound pair. Use
   `layout.namespaces.eval_checkpoint` for `source`, `layout.namespaces.rt_checkpoint` for
   `target`, the configured evaluator consumer for `producer` and the distinct configured
   realtime consumer names for `consumers`. The installer locks both checkpoint tables,
   installs the triggers, and backfills existing receipts in one transaction.
   After an uncertain commit, inspect the installed trigger bindings and run the selected
   realtime receipt readiness check before any retry. A conflicting existing subscription
   requires operator inspection.
4. Restart the roles with the new role files. Record the migration checksums.
