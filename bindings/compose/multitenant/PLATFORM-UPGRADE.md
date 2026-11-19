# Upgrade existing tenant floor proofs

Ordinary Compose and Kubernetes startup run private `POST /v1/platform-verification`.
Admin checks the platform structure and settings-reader privileges and issues the role proofs.
An empty deployment installs its platform schema at bootstrap. Admin provisioning records each
new tenant's insertion floor, write-history floor and encrypted-root proof before returning success.

An existing v3 namespace needs the elevated schema upgrade. A seeded database without current
tenant proofs needs the explicit backfill. Run the applicable steps from the selected
application image with the prepared deployment's private mounts.

1. Stop serving roles for the schema transition. From the bootstrap/migration container, run
   `node deploy/multitenant/platform-startup.js upgrade-tenant-floor-v1`. It uses the
   bootstrap database connection and selected layout, grants admin the registry enumeration
   functions and limits tenant floor reads to the API role under forced tenant RLS. The
   initial schema transition revokes the old proofs. Repeating a completed upgrade preserves
   the current epoch.
2. Start the matching private admin with its generated role verification files. From the private
   verification client run `node deploy/multitenant/platform-verify.js` to issue structural
   proofs. The client uses its configured admin origin and namespace.
3. For existing data requiring floor proofs, run
   `node deploy/multitenant/platform-verify.js backfill-tenant-floor-v1 600000` from the same
   verification client. The last argument is the HTTP timeout in milliseconds. Size it for the
   registry. This explicit operation posts an empty object to
   `/v1/platform-verification/backfills/tenant-floor-v1`. Its success receipt in
   `tenant-floor-backfill-v1.json` gives the namespace and count verified. On a refusal, inspect
   the failed tenant proof and its underlying data, correct the cause and rerun the backfill.
4. Start serving roles with the current platform configuration. Install the generated operator
   configuration with `floorVerification.adminOrigin` and `floorVerification.namespace`.
   Ordinary restore and interrupted-restore resume request an addressed admin proof while
   holding replacement exclusion, after the committed data is visible and before activation.
   A failed proof leaves that tenant suspended.

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
4. Run ordinary platform verification with the new role files, then restart the roles. Record
   the migration checksums and the accepted evaluator and realtime proofs. Keep the independent
   floor backfill above for tenant data that requires it.
