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

`assets/source-contract.json` records the actual immutable image receipt, source commands, SQL
identities and file checksums measured by `check/source-equivalence.py`. The image contains core
and deployment bytes; the Kubernetes binding has its own later commit. Set `imageDeployCommit`
to the deployment bytes in the image and `bindingIdentity` to the package commit. A local Docker
image ID is not a pullable OCI manifest digest. Image delivery needs operator-supplied, verified
registry references or another explicitly qualified delivery path.

The capture supports platform verification v2 and v3. The constructor checks the selected
version against the installed source and preserves each version's startup proof without a lease.
Unknown versions and a v2/v3 mismatch refuse preparation. A later binding commit can use an
existing image only while its complete Compose runtime tree still matches `imageDeployCommit`.

| Source capability | Kubernetes binding |
|---|---|
| API, realtime, evaluator, tenant-admin | api, tenant-admin: one Deployment per role, Recreate, one replica. evaluator, realtime: StatefulSets (slice = pod index). Private HTTP between roles |
| Maintained pgstream producer | Independent one-replica Recreate Deployment, same binary command and private wire Secret; private evaluator intake Service selects the evaluator workload for the chosen profile |
| PostgreSQL/wal2json | Explicit supplied image digest and the source streaming/connection settings; image entrypoint retained for initdb |
| Source bootstrap | Explicit no-retry Job with a finite deadline; source creates registry/admin/management documents and slot/publication configuration |
| API Vault policy | Kubernetes-auth helper imports the source-created policy and adapts the supported tokenFile; projected audience-bound token feeds the native Vault Agent sidecar |
| Admin | Source entrypoint and complete private source documents; only its copied ADMIN_HOSTNAME changes to the actual Pod IP; ClusterIP and operator-only NetworkPolicy |
| UI and edge | Source UI preload/command and byte-identical nginx asset; ClusterIP consumer entry |
| Tenant provisioning | A database verification Job admits serving. An independent lab Job provisions synthetic tenants through the private admin API. |

Core constructs the tenant documents, credentials, application lifecycle state and authority.
The binding projects only deployment addresses before the admin screens those documents.
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

The evaluator is a StatefulSet held at K=1 (`slices.evaluator` must be 1): pgstream delivers to
one receiver, and evaluator K>1 is not supported by this binding.

Role Secret files are copied from Kubernetes symlinks into regular 0400 files inside private 0700
directories. This includes extensionless source token files. The installer test passes the copied
admin environment through the actual source environment reader and confirms it refuses group-readable
input. No Secret or literal credential is rendered.

## Per-role contracts

`lib/ns/components.libsonnet` renders one workload per role from the shared role Pod template
(`roleTemplate`, not rendered itself). Each role owns a private ClusterIP Service at
`<role>-internal`, on ports 19001–19004 for API, evaluator, realtime and tenant-admin respectively.
The evaluator intake remains `evaluator:19913`. Private Services publish addresses before clinical
readiness so lifecycle and intake readiness cannot deadlock startup. Core still checks its own
storage admission on each contract.

`ops/network-documents.cjs` removes socket selections and sets the existing core HTTP listener and
peer URL keys. It updates the admin's private verification environments and the operator participant
endpoints from the same addresses. It preserves role configurations, credentials, participant IDs,
native generation and the producer wire. Only API receives the existing API Vault Agent and token
sink. Other roles retain their source-specific token files; they receive no API Agent token.

Default deny ingress and directed policies admit the four roles and the operator to private role
ports, edge/operator to consumer API/realtime ports, and only pgstream to stream intake. Public
Services and edge routes do not expose private listeners. Actual NetworkPolicy enforcement requires
a live negative connectivity check.

P's `startup-v2` platform verification runs through private admin before serving. Its receipt has
namespace, exact role roster and generation digests, with no lease or timestamp. The verification Job publishes the receipt in its completion log; the source verifier refuses anything but
a complete `verified` receipt. Each serving role checks its own proof generation and fails closed,
and serving admission checks current database, role and epoch identity, so the binding does not
re-derive the generations. The provision `done` container only projects network addresses,
publishes a public provenance record and holds the private state for export; source, catalogue,
commit and binary identity come from the image digest and Job ordering
(`architecture-justified-removal`).

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
| `existing-claim` | Only explicit `storage.claims.{postgres,vault,provisionState}` references | Requires operator-owned, unshared claims and storage qualification |

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
NS_TEST_CORE=/path/to/core node --test check/slices.test.js check/profiles.test.js
node check/invariants.js --env environments/separate-k1
node --test check/vault-kubernetes-auth.test.js check/installer.test.js
bash check/golden.sh
```

`inventory` is a hidden Jsonnet field and is never applied. It names source/image/binding identity,
run ownership, workloads/commands/budgets, Services, document filenames, Secret references, storage,
export rendezvous paths and the commissioning order. `check/invariants.js --root <consumer-root>
--env <environment>` checks a private consumer without needing a Compose checkout.

To remeasure source equivalence, provide the exact local immutable app image and frozen Compose tree:

```bash
python check/source-equivalence.py --compose <frozen-bindings/compose> --image <local-image-id> --diagnostic <immutable-candidate-receipt>
```

This starts only an inert network-disabled Node document constructor. It records the embedded
receipt, the installed source bytes and binary digest as the image carries them (a later
binding-only Compose commit is not a refusal), then compares all SQL identities and source
commands with the retained contract unless `--capture` is given. It does
not rerun application acceptance. `--capture` updates the retained source facts and must accompany
an explicitly selected new source tuple, never a relabeling of inherited acceptance.

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
2. Operator runs `scripts/secrets.sh seed <namespace> <compat-arg>` with explicit `NS_KUBE_CONTEXT`
   and matching `NS_RUN_ID`. The helper verifies Namespace ownership and refuses existing Secrets.
3. Apply the provision Job. Its bootstrap reaches the Vault API over TLS at the headless
   `vault-bootstrap` Service, including during unseal. The serving Service uses Vault health
   readiness. An uninitialized fixture accepts bootstrap and a sealed fixture returns HTTP 503.
   The fixture certificate covers both Service names. After bootstrap and Kubernetes auth,
   the `done` container waits at `/state/.ready` for private export within `activeDeadlineSeconds`.
4. Operator runs `scripts/secrets.sh publish <namespace> <compat-image-arg>`. It verifies the owned
   Pod UID, exports directly into a private temporary directory, creates role Secrets, then
   acknowledges `/state/.exported`. Job completion follows export. There is no reader Pod or volume.
5. Apply the private admin Deployment and wait for its health check. Run the verification Job
   with suspension disabled. Wait for Job completion and collect the public receipt from its
   `done` container log. The serving roles check their live verification generation at startup.
6. Apply the serving workloads. Run the optional primer Job with suspension disabled when
   synthetic tenants are needed. Its client generates the roster from `--tenant-count` and
   provisions it through admin. In its `done` container, run
   `NS_PRIMER_CONFIG=/run/ns-primer/config.json NS_PRIMER_STATE=/run/ns-client node deploy/multitenant/prime.js prime`
   to create synthetic DATA credentials. Export the required files from `/run/ns-client`
   into the owned private test packet. Touch `/run/ns-client/.exported` once custody transfers.
   The finite Job deadline covers these steps. Private client results use a disk-backed
   `emptyDir` with no volume size limit. The configuration Secret contains the client endpoints and verification selection.
7. Observe the tiny synthetic trial under the finite environment deadline. Cleanup verifies actual
   Namespace UID/run label and the exact tokenreview binding ownership before deleting those owned
   resources. Retain private evidence before removing disposable storage. Namespace deletion does
   not delete existing external claims; their retention/cleanup remains with their owner.

Missing durable ownership,
source/image mismatch, incomplete provisioning, or failed application admission remains a refusal.
Run the focused C3 document controls in its network-isolated local app image:

```bash
docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=32m \
  --mount "type=bind,source=$PWD,target=/check,readonly" \
  --entrypoint node "$(jq -r .localImageId assets/source-contract.json)" --test /check/check/candidate-documents.test.cjs
```

The test constructs documents from the installed source and exercises the source admin controller
and client with a synthetic verification response. Kubernetes application and capacity evidence
requires an admitted run and the existing write, storage, clinical, frame and authority oracles.
