# Platform floor-verification upgrade

The API tenant-cache change uses platform verification v4. Existing v3
namespaces need an explicit schema step before verification; the serving API
performs no DDL and refuses an old or missing proof.

Stop serving roles for the platform migration. In the deployment's admin
migration operation, call `platform-startup.upgrade(admin, layout)` with its
existing elevated PostgreSQL connection and selected deployment layout. This
creates the per-tenant result table, grants API reads under forced tenant RLS,
retains the existing proof writer, and revokes old role proofs. It also grants
the admin verifier the existing bounded registry-enumeration functions so it
can check tenant postconditions after migration. No writer credential belongs
in the Job or serving-role configuration.

Call the private admin `POST /v1/platform-verification` operation after the
schema migration and before starting serving roles. It verifies platform
structure and records each tenant's insertion floor, public-history floor and
encrypted-root completeness. A failed tenant result refuses that tenant;
structural or verification-store failures refuse the role proof.

Regenerate paired operator configuration. Its `floorVerification` selection
names only the private admin origin and verification namespace. Restore calls
`POST /v1/platform-verification/tenants/{tenant}` after DATA commits and before
ACTIVATION, while retaining the replacement lock. Interrupted restore resume
performs the same postcondition before activation. A failed check keeps the
tenant suspended. Operator database roles receive no proof-write privilege.

Fresh deployments continue through `platform-startup.install` at bootstrap.
Do not rerun the fresh bootstrap against an existing database. Upgrade behavior
is exercised by core's native tenant-floor verification test, which begins
with the old proof-table shape and invokes the explicit upgrade.
