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
