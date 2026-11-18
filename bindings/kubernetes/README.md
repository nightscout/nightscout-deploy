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

`assets/source-contract.json` records the actual immutable image receipt, source commands, SQL
identities and file checksums measured by `check/source-equivalence.py`. The image contains core
and deployment bytes; the Kubernetes binding has its own later commit. Set `imageDeployCommit`
to the deployment bytes in the image and `bindingIdentity` to the package commit. A local Docker
image ID is not a pullable OCI manifest digest. Image delivery needs operator-supplied, verified
registry references or another explicitly qualified delivery path.

| Source capability | Kubernetes binding |
|---|---|
| API, realtime, evaluator, tenant-admin | `separate-k1`: one Deployment per role, Recreate, one replica; private HTTP. `cohort`: one StatefulSet with private Unix sockets |
| Maintained pgstream producer | Independent one-replica Recreate Deployment, same binary command and private wire Secret; private evaluator intake Service selects the evaluator workload for the chosen profile |
| PostgreSQL/wal2json | Explicit supplied image digest and the source streaming/connection settings; image entrypoint retained for initdb |
| Source bootstrap | Explicit no-retry Job with a finite deadline; source creates registry/admin/management documents and slot/publication configuration |
| API Vault policy | Kubernetes-auth helper imports the source-created policy and adapts the supported tokenFile; projected audience-bound token feeds the native Vault Agent sidecar |
| Admin | Source entrypoint and complete private source documents; only its copied ADMIN_HOSTNAME changes to the actual Pod IP; ClusterIP and operator-only NetworkPolicy |
| UI and edge | Source UI preload/command and byte-identical nginx asset; ClusterIP consumer entry |
| Tenant provisioning | Separate suspended primer Job runs the source command through the private admin API; operator explicitly unsuspends it after admin readiness and verifies the platform before serving roles start |

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
volume. The inventory contains twelve workloads. Each role owns a private ClusterIP Service at
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

P's `startup-v2` platform verification runs through private admin before serving. Its receipt has
namespace, exact role roster and generation digests, with no lease or timestamp. The constructor
compares the actual receipt against source-loaded expected generations. Serving admission checks
current database, role and epoch identity. The legacy receipt reader retains its expiry checks.

Recreate and one replica express rollout intent. They do not prove old-backend termination for a
manual Pod delete, partition or restore. Qualification must observe the actual old process/backend
termination or fencing and changed participant incarnation. Baseline Pod UID guards keep refusing
unplanned replacements. This profile supplies K=1 placement; K>1 and HA need their own contracts.

## Inputs and storage

All init containers, Vault sidecars and serving/provisioning containers have explicit CPU, memory
and ephemeral-storage requests. `resourceAccounting: "requests-v1"` keeps authored limits only;
the legacy `limits-v1` mode retains the bounded synthetic defaults. `resources.<container-name>` overrides the bounded
synthetic defaults. These defaults are not measured sizing. `placement` sets Pod scheduling fields;
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
node check/controls.js
node --test check/separate-k1.test.js
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

This starts only an inert network-disabled Node document constructor. It compares the embedded
receipt and installed source bytes, then compares all SQL identities and source commands. It does
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
3. Apply provision Job. Its source bootstrap and Kubernetes auth run in order. The `done` container
   waits at `/state/.ready` for private export, within `activeDeadlineSeconds`.
4. Operator runs `scripts/secrets.sh publish <namespace> <compat-image-arg>`. It verifies the owned
   Pod UID, exports directly into a private temporary directory, creates role Secrets, then
   acknowledges `/state/.exported`. Job completion follows export. There is no reader Pod or volume.
5. Apply only the private admin Deployment and wait for its health check. Apply primer suspended
   and explicitly unsuspend it. It provisions the synthetic tenants and calls the private admin
   verification API. Wait for the primer to be ready and export its non-secret
   `/run/ns-primer/verified.json` proof from the owned Pod. The proof binds the fixture, native
   lifecycle selection and expected generations of the three serving roles.
6. Apply the remaining serving workloads and wait for their readiness. The serving roles require the
   live verification record and open tenants on demand. Run the source-owned
   `node deploy/multitenant/prime.js prime` in primer's `done` container within the run deadline
   with `NS_PRIMER_STATE=/run/ns-primer`. Export `/run/ns-primer/tenants.json` to the owned
   private test packet. This file contains synthetic test authority. Capture the adapter's
   `candidate-proof` and `policy` while the same primer container is still waiting. Acknowledge
   `/run/ns-primer/.exported` after these observations and after any phase that requires the same
   live container observation. Follow the finite job deadline throughout.
7. Observe the tiny synthetic trial under the finite environment deadline. Cleanup verifies actual
   Namespace UID/run label and the exact tokenreview binding ownership before deleting those owned
   resources. Retain private evidence before removing disposable storage. Namespace deletion does
   not delete existing external claims; their retention/cleanup remains with their owner.

Do not force-delete a cohort Pod to bypass sequential replacement. Missing durable ownership,
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
