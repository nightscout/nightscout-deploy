# Kubernetes binding

This package binds the current core and deployment source to ordinary Kubernetes resources.
Each role runs in its own workload (decisions `k1-per-role-deployments`,
`statefulset-ordinal-scaling`): api and tenant-admin are one-replica Recreate Deployments;
evaluator and realtime are StatefulSets whose Pod ordinal is the slice. The shared `cohort`
StatefulSet is retired. Live correctness and repeatability remain
**UNMEASURED** until the selected tuple completes its synthetic network baseline.

`lib/ns/nightscout.libsonnet` exposes `new(overrides)` with package-local imports.
`environments/separate-k1/inputs.json` and `environments/synthetic/inputs.json` are render examples
with unavailable image references. Supply verified immutable image references before applying.
The original `check/golden/preview.yaml` is a historical capture. Current checks render their
inputs and verify their contracts; the historical capture grants no current qualification.

## Source and runtime ownership

The image contains core and deployment bytes; the Kubernetes binding has its own later commit.
Set `imageDeployCommit` to the deployment bytes in the image and `bindingIdentity` to the package
commit. Image identity is the immutable image digest (the Pod `imageID`), not a source-file
checksum. A local Docker image ID is not a pullable OCI manifest digest. Image delivery needs
operator-supplied, verified registry references or another explicitly qualified delivery path.

| Source capability | Kubernetes binding |
|---|---|
| API, realtime, evaluator, tenant-admin | api, tenant-admin: one Deployment per role, Recreate, one replica. evaluator, realtime: StatefulSets (slice = pod index). Private HTTP between roles |
| PostgreSQL | Explicit supplied image digest and the source connection settings; image entrypoint retained for initdb |
| Source bootstrap | Explicit no-retry Job with a finite deadline; consumes seeded credentials and creates roles, schemas and Vault tokens; each role mounts its scoped credential Secret |
| API Vault policy | Kubernetes-auth helper imports the source-created policy and adapts the supported tokenFile; projected audience-bound token feeds the native Vault Agent sidecar |
| Admin | Core admin entrypoint with mounted credentials and its Pod IP from the downward API, behind a ClusterIP and operator-only NetworkPolicy |
| UI and edge | Source UI preload/command and byte-identical nginx asset; ClusterIP consumer entry |
| Tenant provisioning | An independent lab Job provisions synthetic tenants through the private admin API. |

Core derives role configuration and authority from declared settings and installed catalogue grants.
The binding supplies deployment addresses and scoped credential files.
Deployments use Recreate, StatefulSets the ordinary rolling update, and no HPA is generated.
Separate experiment namespaces have separate databases/Vault state.

## Slices (realtime K)

`slices.realtime` (default 1, at most 8) is the one value that sets both the realtime
StatefulSet's `replicas` and the `NS_SLICE_COUNT` it renders into the Pod template. Each Pod reads
its ordinal from the `apps.kubernetes.io/pod-index` label through the downward API
(`NS_SLICE_ORDINAL`) and owns the tenants with `sha256(tenant) mod K == ordinal` (core
`lib/pool-membership/slice.js`). Change K only through `slices.realtime`; a bare `kubectl scale`
leaves the env at the old K, and a Pod whose ordinal is at or above K owns nothing. A K change
changes the Pod template, so `tk apply` performs an ordinary StatefulSet rolling update.

At K>1 the binding adds a `socket-edge` Deployment (the Compose `socket-edge.js`, conformance-tested
against `slice.js`) that routes each tenant's realtime connections to its owning Pod by its stable
DNS name `realtime-<n>.realtime-peers`; the edge nginx `realtime` upstream points at it, and the
evaluator receives `NS_REALTIME_SLICE_PEERS` in ordinal order. At K=1 none of this is rendered.

## Evaluator K

`slices.evaluator` (default 1, at most 8) sets the evaluator StatefulSet's `replicas` and its
one environment value `NS_EVALUATOR_SLICES` (decision `statefulset-ordinal-scaling`). The
StatefulSet is governed by the headless `evaluator` Service on 19002, so Pod `evaluator-<i>` is
`evaluator-<i>.evaluator`. At K=1 the one Pod is the unsliced evaluator.

At K>1 each Pod derives its ordinal and slice from its hostname and K. There is no shell shim, no
downward-API field and no per-ordinal Service. A Pod whose ordinal is K or more owns nothing and is
not refused; keeping `replicas` equal to K is the binding's job. Compose takes the same path by
giving each evaluator service `hostname: evaluator-<i>` and the alias `evaluator-<i>.evaluator`.

- **Seed with the same K:** `NS_EVALUATOR_WORKERS=K scripts/secrets.sh seed ...` (the inventory's
  `seed.environment` names it). Bootstrap records K; changing K needs a fresh namespace.

Role Secret files are copied from Kubernetes symlinks into regular 0400 files inside private 0700
directories. This includes extensionless source token files. The installer test passes the copied
admin environment through the actual source environment reader and confirms it refuses group-readable
input. No Secret or literal credential is rendered.

## PostgreSQL sizing and its own node

One PostgreSQL primary, on its own node, sized vertically. `postgresSizing: '1k' | '5k' | '10k'` selects a
tier from `lib/ns/postgres-sizing.json`: server settings (`-c` flags), CPU and memory requests (memory never
below the planned connection and `/dev/shm` figure) and, in dynamic storage mode, the claim size. Explicit
`postgresSettings`, `resources.postgres.requests` and `storage.postgres` each win over the tier.
`max_connections`, `reserved_connections`, `shared_preload_libraries` and `track_io_timing` stay owned by
the binding and are refused in either place. A restored fixture claim (existing-claim mode) is sized by
whoever restores it: use at least the tier's `claim` (the database plus `max_wal_size` plus growth). The tier
figures come from the 10k packets (database 44-50 GB; read-derived for 5k and 1k) and stay provisional until
the ladder measures them.

`postgresNode: { nodeSelector: {...}, taint: { key, value } }` gives the postgres Pod that node selector and a
`NoSchedule` toleration for `key=value`, added to the run's own `placement.tolerations`. The render refuses
any other workload that would tolerate the key, a `placementByWorkload.postgres` beside it, and a
`placement.nodeName`. The node pool and its taint are made by the operator, for example (not run by any tool
here):

    doctl kubernetes cluster node-pool create <cluster> --name <run>-pg --size m-16vcpu-128gb --count 1 \
      --taint nightscout.org/dedicated=postgres:NoSchedule

with `postgresNode: { nodeSelector: { "doks.digitalocean.com/node-pool": "<run>-pg" }, taint: { key:
"nightscout.org/dedicated", value: "postgres" } }`. `NoSchedule` affects only new scheduling: a new pool has no
Pods, and nothing already running elsewhere is evicted. Without either input the render is unchanged
(`check/postgres-sizing.test.js`).

## Lab metrics (opt-in)

`labMetrics: {enabled: true}` adds, in the run namespace only: one Prometheus Deployment (pinned
digest, admin API on for a TSDB snapshot before teardown, emptyDir storage), a `postgres_exporter`
sidecar in the postgres Pod (Unix socket, local superuser, `pg_stat_statements` with query text,
and lab queries for `pg_stat_io` and backends by
`application_name`), and `NS_METRICS=true` on api, evaluator, realtime and tenant-admin. Prometheus
discovers Pods through each `<role>-internal` Service's EndpointSlices, so every evaluator ordinal
is its own target, under a namespace Role (get/list/watch Pods, Services, Endpoints,
EndpointSlices). No cluster-scoped object, operator, kube-prometheus-stack or Grafana. Off (the
default) renders byte-identically to a binding without the component (`check/lab-metrics.test.js`).

## Per-role contracts

`lib/ns/components.libsonnet` renders one workload per role from the shared role Pod template
(`roleTemplate`, not rendered itself). Each role owns a private ClusterIP Service at
`<role>-internal`, on ports 19001–19004 for API, evaluator, realtime and tenant-admin respectively.
Private Services publish addresses before clinical
readiness so lifecycle readiness cannot deadlock startup. Core still checks its own
storage admission on each contract.

Each role receives its private HTTP listener and peer Service addresses in the Pod environment.
The API receives the Vault Agent token sink at `/run/ns-vault/token`. Tenant-admin and admin read
their own scoped token files directly from projected Secrets.

The deployment signing secret (decision `deployment-signing-secret`) is one Secret,
`ns-signing-secret`, seeded once by `scripts/secrets.sh seed` and mounted read-only at
`/run/ns-signing/signing-secret` (`NS_SIGNING_SECRET_FILE`) into exactly the roles that issue tokens:
api, admin and tenant-admin (checked by `check/invariants.js` `signing-secret-one-object`). Vault
holds no copy and the Agent renders only its token. Production may fill that Secret from Vault with
an operator; there is no per-role Agent path. A fixture carries that one object: a
restore re-creates the seed run's Secrets, `ns-signing-secret` among them, because the restored
PostgreSQL holds public keys derived from it and issuers refuse a key they cannot derive
(`SIGNING_KEY_MISMATCH`).

Default deny ingress and directed policies admit the four roles and the operator to private role
ports and edge/operator to consumer API/realtime ports. Public
Services and edge routes do not expose private listeners. Actual NetworkPolicy enforcement requires
a live negative connectivity check.

Secrets flow into Jobs and roles, never out (decision `provisioning-secrets-in`).
`scripts/secrets.sh seed` creates the role credentials before apply
in the application image (`ops/seed.cjs`, which runs the deployment's
`credentials.js` and `render.js`). The provision Job only reads its mounted
`ns-credentials-postgres` and `ns-credentials-vault` Secrets to create the PostgreSQL roles and the
Vault tokens with the seeded ids. Vault's own unseal key and root token come from its
initialization and stay on the Job's `provision-state` volume. No container holds output for
export and nothing waits for an acknowledgement. The tenant-admin Secret also carries its
dedicated owner settings login. Existing installations follow the
[owner display settings upgrade](../compose/multitenant/PLATFORM-UPGRADE.md#enable-owner-display-editing-on-an-existing-deployment).

Recreate and one replica express rollout intent. They do not prove old-backend termination for a
manual Pod delete, partition or restore. Qualification must observe the actual old process/backend
termination or fencing.

## Inputs and storage

PostgreSQL `max_connections` is rendered from the connection budget
(`lib/ns/connection-budget.libsonnet`): the pool maximum of every role process times its Pods, about
three transient health and readiness clients per serving Pod, the three superuser slots and the 40
clinical slots (`reserved_connections`). It is never below 140. Pool sizes are inputs
(`{"pools": {"api": 4, "realtime": 4, "evaluator": 4, "operation": 8, "read": 2}}`, the core
defaults) and reach each role as `NS_POOL_<ROLE>_MAX`. With 2 api replicas and evaluator and realtime
K = 1, 2, 4 and 8 the budget is 205, 248, 334 and 506. An explicit `postgresMaxConnections` (44 to
10,000) must hold the budget, or the render refuses. The PostgreSQL memory request adds 2 MiB per
connection above 140 to its typical request.

The evaluator memory request is `baseMiB + perResidentMiB x residentMax`, with no limit. The
defaults, 1745 and 2.96, are the upper envelope of the measured evaluator resident-set peaks on the
v2 client-model history with the window levers on (17 evaluator Pods at 223 to 1,032 residents,
plannable-scale discovery 2026-11-21/22): least squares gives `1110 + 2.961 x residents` MiB, and
the intercept is raised by the largest residual (632 MiB) so that every measured peak is at or below
the line. The model overstates small deployments (a 16-tenant smoke peaked at 490 MiB) and its slope
is a floor: the 1,000-resident peaks sat at V8's default heap ceiling. Refit with
`{"evaluatorMemory": {"baseMiB": ..., "perResidentMiB": ...}}`.

The same plan sets the evaluator's V8 heap ceiling: the evaluator command is
`node --max-old-space-size=<heapMiB> deploy/multitenant/entrypoint.js evaluator` with
`heapMiB = ceil(heapHeadroom x memory request)` (`evaluatorMemory.heapHeadroom`, default 1.5, 1 to
4). Without the flag V8's default old-space limit, about 4 GB on the 64-bit Node 24 image, ends the
process ("JavaScript heap out of memory", exit 139) below a larger request; that was measured on
1,000 v2-history tenants at K=1 with the window levers off. The flag is in the command, never in
`NODE_OPTIONS`: like the Compose private role environment, `roleEnv` refuses `NODE_OPTIONS`,
`NODE_PATH`, `PATH`, `LD_PRELOAD` and `NS_ENV_FILE`. An authored evaluator request above the heap
ceiling fails the `evaluator-statefulset` check; raise the model or the headroom instead. At 10,000
tenants and K=8 the render plans 1,399 residents, a 5,887 MiB request and an 8,831 MiB heap ceiling
per evaluator. The ceiling is not a container limit: an evaluator that grows towards it uses memory
above its request.
`PREDICTIONS_MAX_SIZE`, the single-site cap on each OpenAPS prediction curve an API v1 device
status stores, is set with a `roleEnv.api` row (for example `{ "name": "PREDICTIONS_MAX_SIZE",
"value": "48" }`). Every API replica gets it, and core gives every tenant that one value with the
single-site rules (unset or invalid `288`, `0` keeps whole curves). It is not a tenant setting
(`check/role-env.test.js`).
`NS_EVALUATOR_RESIDENT_MAX` (`residentMax`) bounds the busiest slice, not the mean: tenant ids are
unknown at render time and ownership is a hash, so a slice owns `Binomial(tenantCount, 1/K)` tenants.
`residentMax = min(tenantCount, ceil(mean + z x sqrt(mean x (1 - 1/K))))` with `mean = tenantCount / K`
and `z = residentHeadroomZ` (default 4.5; the chance that any slice at K <= 8 exceeds it is below
8e-5; 3.4e-5 at 10,000 tenants; at 10,000 tenants it is 9.0e-5 for K=20 and 1.9e-4 for K=32, union bound
over slices of the exact binomial tail; evaluator K is 1 to 32, realtime K 1 to 8). A slice over its limit evicts and reloads tenants rather than refusing them. A `roleEnv.evaluator` row of the
same name replaces the rendered value. Read the live limit with `SHOW max_connections` and the
planned terms in the render inventory (`connectionBudget`).

All init containers, Vault sidecars and serving/provisioning containers have explicit CPU, memory
and ephemeral-storage requests. The namespace quota allows two copies of each
declared workload so a controller can replace its Pod. It accounts CPU, memory,
ephemeral storage and Pod count. The LimitRange supplies requests when a
container omits them. The default `requests-v1` mode renders limits only when supplied in
`resources.<container-name>.limits`. The shared typical request profile is in `lib/ns/typical-requests.json`. Explicit `limits-v1` selects the legacy bounded profile. `placement` sets Pod scheduling fields;
`placementByWorkload.<name>` overrides them. Supported staging fields include nodeName,
nodeSelector, tolerations, affinity and topologySpreadConstraints. An explicit existing nodeName
requires environment-owned headroom/admission checks; it does not reserve resources.
`imagePullSecrets` names existing same-namespace Secrets and is copied to every Pod template.

| `storage.mode` | Rendered storage | Qualification limit |
|---|---|---|
| `dynamic` (legacy default) | PostgreSQL/Vault claim templates and provision-state PVC | May incur new volume charges |
| `disposable` | Bounded per-Pod emptyDir; no PVC | Backing-store Pod replacement loses state; never a durability result |
| `existing-claim` | Only explicit `storage.claims.{postgres,vault,provisionState}` references (optional `primerResults`) | Requires operator-owned, unshared claims and storage qualification |

`profile: 'existing-capacity'` refuses dynamic storage and public Services. Its gate also rejects
provider-resource manifests, hostPath and unbounded emptyDirs. It cannot prove actual node headroom,
autoscaling behavior, registry allowance, transfer cost or policy enforcement. Lane E owns those
read-only preflight facts. No cloud resource is created by rendering.

Kubernetes native sidecars require a supporting cluster (1.29 or newer for this binding). Use a
compatible kubectl and a CNI that enforces NetworkPolicy. Vault Kubernetes auth requires the named
ClusterRoleBinding to system:auth-delegator in addition to namespace permission. The fixture inventory
names that exact cluster-scoped cleanup object. Tanka v0.20.0 is used for offline eval/show only.

## Inspect and check offline

From this directory:

```bash
tk eval environments/synthetic > /tmp/synthetic-resources.json
tk eval environments/synthetic -e inventory > /tmp/synthetic-inventory.json
tk show --dangerous-allow-redirect environments/synthetic > /tmp/synthetic.yaml
node check/invariants.js
NS_TEST_CORE=/path/to/core node --test check/slices.test.js check/evaluator-slices.test.js check/profiles.test.js
node check/invariants.js --env environments/separate-k1
node --test check/vault-kubernetes-auth.test.js check/installer.test.js
bash check/golden.sh
```

`inventory` is a hidden Jsonnet field and is never applied. It names source/image/binding identity,
run ownership, workloads/commands/budgets, Services, document filenames, Secret references, storage,
the seeded Secrets, where lab client results stay, and the commissioning order.
`check/invariants.js --root <consumer-root> --env <environment>` checks a private consumer without
needing a Compose checkout.

## Export a clean package

After committing the binding, from this directory:

```bash
python scripts/export-package.py --commit HEAD --output <new-absolute-artifact-directory>
```

The exporter uses `git archive` of the exact clean commit. It writes `package/`, `package.tar`, a
checksum receipt, a separate standalone `consumer/`, deterministic resource JSON/YAML and
`fixture-inventory.json`. That independent consumer imports the package without any sibling
Compose path. Private overlays use the same complete immutable `package/`, then supply their own
private inputs and the receipt's binding commit. Do not commit private environment inputs here.

## Operator commissioning boundary

Lane E supplies the actual context, existing-capacity checks, image delivery and scoped commands.
Lane T supplies workload/authority/stored-write/clinical/frame observations. No live operation is
performed by the offline checks above.

1. Inspect the exact rendered objects/inventory and environment preflight. Create only the owned
   Namespace and explicit trust/policy/ConfigMap/store objects. Do not borrow existing workload state.
2. Operator runs `scripts/secrets.sh seed <namespace> <app image>` with explicit `NS_KUBE_CONTEXT`,
   matching `NS_RUN_ID` and the binding's `NS_APPLICATION_TOPOLOGY`. The helper verifies Namespace
   ownership, refuses existing Secrets, and needs docker with the application image locally.
3. Apply everything once. The provision Job's bootstrap reaches the Vault API over TLS at the
   headless `vault-bootstrap` Service, including during unseal; the serving Service uses Vault
   health readiness. The fixture certificate covers both Service names. The Job completes after
   Kubernetes auth is configured; the roles start from their seeded documents and become ready once
   their schemas and Vault tokens exist.
4. Run the optional primer Job with suspension disabled when synthetic tenants are needed. It
   provisions the `--tenant-count` roster through admin and writes its private results to
   `/run/ns-client` on its own volume: the `primer-results` claim with dynamic storage, a claim
   named in `storage.claims.primerResults`, or otherwise the Pod's disk-backed `emptyDir`. An
   in-cluster consumer mounts that claim; nothing is exported by `kubectl exec`.
5. Observe the tiny synthetic trial under the finite environment deadline. Cleanup verifies actual
   Namespace UID/run label and the exact tokenreview binding ownership before deleting those owned
   resources. Retain private evidence before removing disposable storage. Namespace deletion does
   not delete existing external claims; their retention/cleanup remains with their owner.

Missing durable ownership,
incomplete provisioning, or failed application admission remains a refusal. Kubernetes application
and capacity evidence requires an admitted run and the existing write, storage, clinical, frame and
authority oracles.

### Restore a cold synthetic fixture

Declare `migration.largestRelationBytes` (largest restored relation's heap bytes) to budget
concurrent index builds. The binding sets the bootstrap index build timeout to max(60 s,
ceil(bytes / `buildBytesPerSecond` × `safetyFactor`)). The defaults are 220,000,000 bytes/s
(measured on 2026-11-24 for a 13,110,624,256-byte heap indexed in 59.613 s) and 3.
`migrationIndexBuildTimeoutMs` can raise this budget up to 86,400,000 ms.
Independent ordinary migration statements use `migrationStatementTimeoutMs` (1–600,000 ms).
When omitted, the core defaults are 1,800,000 ms for index builds and 60,000 ms for ordinary
statements. The provision Job reserves the larger declared timeout × `longStatements` (1)
plus `otherStepsSeconds` (300). The binding raises the default 900 s deadline as needed and
refuses an authored deadline below the reservation.

`/dev/shm` for PostgreSQL is 1,024 MiB plus max(1, `max_parallel_maintenance_workers`) ×
`maintenance_work_mem` when the effective settings name `maintenance_work_mem` (PostgreSQL's
default of 2 workers when the count is not named).

For a storage-backed run, keep the four PVCs used by PostgreSQL, Vault, the provision Job
and the primer Job together with the matching `ns-config-*`, `ns-credentials-*`,
`ns-postgres-password`, `ns-ca` and `ns-vault-tls` Secrets. The primer Job makes one bulk
provisioning call per 100 tenants with a bootstrap block and writes the roster from the
responses; it makes no DATA API call. Its claim contains private client credentials in
`tenants.json`. The optional top-level `primerConcurrency` input (batch calls in flight)
defaults to 4.

Quiesce every workload that can write these claims, terminate its Pods, then render
`fixture.snapshots(namespace, snapshotClass, sourceClaims, snapshotNames)` from
[`fixture.libsonnet`](lib/ns/fixture.libsonnet). Each map has the keys `postgres`, `vault`,
`provisionState` and `primerResults`. Wait for all four VolumeSnapshots to report
`status.readyToUse: true` before resuming the source. Keep the matching Secrets under the
same access controls for the lifetime of the fixture.

In the same namespace, render
`fixture.claims(namespace, 'VolumeSnapshot', snapshotNames, targetNames, sizes, storageClass)`
with fresh PVC names and the source capacities. A driver that supports direct PVC clones
can instead use `'PersistentVolumeClaim'` with the cold source PVC names. Wait for binding
according to the StorageClass, then run the ordinary provision Job and role startup with
`storage: {mode: 'existing-claim', claims: targetNames}` and the original Secrets. Start
with the same PostgreSQL major version and Vault storage configuration.
Recreate a completed provision Job for this run. Keep the completed primer results
as the workload driver's inputs.

A VolumeSnapshot and a claim's `dataSource` are namespaced. To restore into a fresh
namespace, record each ready snapshot's `status.snapshotHandle` from its
VolumeSnapshotContent and set that content's `deletionPolicy` to `Retain` before the source
namespace is deleted. In the new namespace, create the original Secrets, then render
`fixture.imported(namespace, driver, snapshotClass, handles, snapshotNames, labels)`: one
cluster-scoped VolumeSnapshotContent (`Retain`) and one VolumeSnapshot per part. Then render
`fixture.claims(...)` from those snapshot names. Delete the run's contents by label with the
namespace; the provider snapshots remain until the fixture owner deletes them. The provision
Job's `vault-kubernetes-auth` step rebinds the Vault Kubernetes auth role when the copied
record names another namespace. `fixture.volumes(...)` renders the empty claims for the run
that seeds a fixture.

Only use this path with operator-approved storage allocation. Existing-capacity disposable
runs seed and prime through the run controller on each run. The binding never installs a CSI
controller or creates snapshots during ordinary startup.
