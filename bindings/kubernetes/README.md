# Kubernetes binding

This package binds the current core and deployment source to ordinary Kubernetes resources.
`applicationTopology: "separate-k1"` places API, evaluator, realtime and tenant-admin in separate
one-replica Deployments. The default `cohort` profile retains the shared StatefulSet. Both profiles
use the same source-owned roles and startup sequence. Live correctness and repeatability remain
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
| API, realtime, evaluator, tenant-admin | `separate-k1`: one Deployment per role, Recreate, one replica; private HTTP. `cohort`: one StatefulSet with private Unix sockets |
| Maintained pgstream producer | Independent one-replica Recreate Deployment, same binary command and private wire Secret; private evaluator intake Service selects the evaluator workload for the chosen profile |
| PostgreSQL/wal2json | Explicit supplied image digest and the source streaming/connection settings; image entrypoint retained for initdb |
| Source bootstrap | Explicit no-retry Job with a finite deadline; consumes seeded credentials and creates roles, schemas, Vault tokens and slot/publication configuration; role documents are rendered before apply |
| API Vault policy | Kubernetes-auth helper imports the source-created policy and adapts the supported tokenFile; projected audience-bound token feeds the native Vault Agent sidecar |
| Admin | Source entrypoint and complete private source documents; only its copied ADMIN_HOSTNAME changes to the actual Pod IP; ClusterIP and operator-only NetworkPolicy |
| UI and edge | Source UI preload/command and byte-identical nginx asset; ClusterIP consumer entry |
| Tenant provisioning | An independent lab Job provisions synthetic tenants through the private admin API. |

Core constructs the tenant documents, credentials, application lifecycle state and authority.
The separate profile projects only deployment addresses before the admin screens those documents.
Both profiles use one native evaluator intake owner. Evaluator partition
selection remains unqualified and the focused source gate refuses it. StatefulSet replacement is
sequential, Deployments use Recreate, and no HPA is generated. Separate experiment namespaces have
separate databases/Vault state. Never duplicate cohort replicas against one database.

Role Secret files are copied from Kubernetes symlinks into regular 0400 files inside private 0700
directories. This includes extensionless source token files. The installer test passes the copied
admin environment through the actual source environment reader and confirms it refuses group-readable
input. No Secret or literal credential is rendered.

## Separate K=1 contracts

`lib/ns/components.libsonnet` reuses the existing role Pod templates and drops the shared socket
volume. Each role owns a private ClusterIP Service at
`<role>-internal`, on ports 19001–19004 for API, evaluator, realtime and tenant-admin respectively.
The evaluator intake remains `evaluator:19913`. Private Services publish addresses before clinical
readiness so lifecycle and intake readiness cannot deadlock startup. Core still checks its own
storage admission and actual participant incarnation on each contract.

`ops/network-documents.cjs` removes socket selections and sets the existing core HTTP listener and
peer URL keys. It updates the admin's private verification environments and the operator participant
endpoints from the same addresses. It preserves role configurations, credentials, participant IDs,
native generation and the producer wire. Only API receives the existing API Vault Agent and token
sink. Other roles retain their source-specific token files; they receive no API Agent token.

Default deny ingress and directed policies admit the four roles and the operator to private role
ports, edge/operator to consumer API/realtime ports, and only pgstream to stream intake. Public
Services and edge routes do not expose private listeners. Actual NetworkPolicy enforcement requires
a live negative connectivity check.

Secrets flow into Jobs and roles, never out (decision `provisioning-secrets-in`).
`scripts/secrets.sh seed` creates every credential before apply and renders every role document
from them in the application image (`ops/render-documents.cjs`, which runs the deployment's
`credentials.js` and `render.js`). The provision Job only reads its mounted
`ns-credentials-postgres` and `ns-credentials-vault` Secrets to create the PostgreSQL roles and the
Vault tokens with the seeded ids. Vault's own unseal key and root token come from its
initialization and stay on the Job's `provision-state` volume. No container holds output for
export and nothing waits for an acknowledgement.

Recreate and one replica express rollout intent. They do not prove old-backend termination for a
manual Pod delete, partition or restore. Qualification must observe the actual old process/backend
termination or fencing and changed participant incarnation. Baseline Pod UID guards keep refusing
unplanned replacements. This profile supplies K=1 placement; K>1 and HA need their own contracts.

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
node check/controls.js
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

Do not force-delete a cohort Pod to bypass sequential replacement. Missing durable ownership,
incomplete provisioning, or failed application admission remains a refusal. Kubernetes application
and capacity evidence requires an admitted run and the existing write, storage, clinical, frame and
authority oracles.
