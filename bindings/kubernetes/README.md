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
| Maintained pgstream producer | Independent one-replica Recreate Deployment, same binary command and private wire Secret; private evaluator intake Service selects the evaluator workload for the chosen profile |
| PostgreSQL/wal2json | Explicit supplied image digest and the source streaming/connection settings; image entrypoint retained for initdb |
| Source bootstrap | Explicit no-retry Job with a finite deadline; consumes seeded credentials and creates roles, schemas, Vault tokens and slot/publication configuration; each role mounts its scoped credential Secret |
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
StatefulSet is governed by the headless `evaluator` Service on 19913, so Pod `evaluator-<i>` is
`evaluator-<i>.evaluator`. At K=1 the one Pod is the unsliced receiver `http://evaluator:19913/`.

At K>1 each Pod derives everything from its hostname and K (core `hostAssignment` in
`lib/pgstream/assigned-worker.js`): ordinal i, its slice, its owner key, its own receiver
`http://evaluator-<i>.evaluator:19913/` and the roster of K receivers. There is no shell shim, no
downward-API field and no per-ordinal Service. A Pod whose ordinal is K or more owns nothing and is
not refused; keeping `replicas` equal to K is the binding's job. Compose takes the same path by
giving each evaluator service `hostname: evaluator-<i>` and the alias `evaluator-<i>.evaluator`.

- The provision Job's bootstrap step gets `NS_EVALUATOR_WORKERS=K`, so it installs
  `pgstream.webhook_subscriptions` for the same DNS roster. PostgreSQL gets
  `max_wal_senders = max(4, K+2)`; one replication slot either way.
- **Seed with the same K:** `NS_EVALUATOR_WORKERS=K scripts/secrets.sh seed ...` (the inventory's
  `seed.environment` names it). The image then renders `pgstream.yaml` with the patched pgstream's
  `transaction_batch.slice_receivers` for that roster. A mismatch fails loudly at startup.
  K is still fixed when a fixture is seeded; making it a property of the render alone is open.
- The patched pgstream advances the one slot only after every slice accepts, so a slow or failed
  evaluator slice pauses intake for all slices. Bootstrap records K; changing K needs a fresh
  namespace. Live admission, populated-slot rebootstrap and restore at K>1 are not qualified here.

Role Secret files are copied from Kubernetes symlinks into regular 0400 files inside private 0700
directories. This includes extensionless source token files. The installer test passes the copied
admin environment through the actual source environment reader and confirms it refuses group-readable
input. No Secret or literal credential is rendered.

## Lab metrics (opt-in)

`labMetrics: {enabled: true}` adds, in the run namespace only: one Prometheus Deployment (pinned
digest, admin API on for a TSDB snapshot before teardown, emptyDir storage), a `postgres_exporter`
sidecar in the postgres Pod (Unix socket, local superuser, `pg_stat_statements` with query text,
replication slots, and lab queries for walsender waits, slot lag, `pg_stat_io` and backends by
`application_name`), and `NS_METRICS=true` on api, evaluator, realtime and tenant-admin. Prometheus
discovers Pods through each `<role>-internal` Service's EndpointSlices, so every evaluator ordinal
is its own target, under a namespace Role (get/list/watch Pods, Services, Endpoints,
EndpointSlices). No cluster-scoped object, operator, kube-prometheus-stack or Grafana. Off (the
default) renders byte-identically to a binding without the component (`check/lab-metrics.test.js`).

## Per-role contracts

`lib/ns/components.libsonnet` renders one workload per role from the shared role Pod template
(`roleTemplate`, not rendered itself). Each role owns a private ClusterIP Service at
`<role>-internal`, on ports 19001–19004 for API, evaluator, realtime and tenant-admin respectively.
The evaluator intake remains `evaluator:19913`. Private Services publish addresses before clinical
readiness so lifecycle and intake readiness cannot deadlock startup. Core still checks its own
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
ports, edge/operator to consumer API/realtime ports, and only pgstream to stream intake. Public
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
with the same PostgreSQL major version, wal2json plugin and Vault storage configuration.
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
