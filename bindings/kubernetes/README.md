# Kubernetes binding

*Contributor- and operator-facing. State 2026-11-10: rendered, checked offline, and smoked on a kind
cluster (Kubernetes v1.32.2). The smoke record is in the alignment workspace,
`reports/tenancy/k8s-binding-2026-11-10/README.md`. Every row of the equivalence table below says
what was measured.*

A Tanka environment (plain Jsonnet, no vendored libraries) that binds the multitenant Compose tree
in `../compose/` to ordinary Kubernetes resources: the same image, the same commands, the same
per-role private documents at the same paths, the same PostgreSQL identities. Decisions of record
are in the alignment workspace's `releases/cgm-remote-monitor-16.0.0/decisions.md`
(`tanka-binding-parallel`, `internal-listener-ory-pattern`, `admin-plane-same-address-different-port`,
`evaluator-static-partition`, `pool-primitive-shared`, `vault-agent-sidecar`).

| path | holds |
|---|---|
| `lib/ns/nightscout.libsonnet` | the renderer: one function, `new(overrides)` |
| `environments/preview/` | the preview environment: one cohort, one evaluator member, core `16a1fc2d` |
| `ops/vault-kubernetes-auth.js` | provisioning step: the Compose Vault Agent step with Kubernetes auth in place of AppRole |
| `scripts/secrets.sh` | creates every Secret the render references, at apply time; nothing is committed |
| `check/invariants.js` | the rendered-YAML invariants (offline, `tk eval`) |
| `check/controls.js` | one or more break-it controls per invariant, in a scratch copy |
| `check/golden/preview.yaml` | the committed render; `check/golden.sh` requires it to equal `tk show` |
| `check/vault-kubernetes-auth.test.js` | the provisioning step against a recorded fake Vault |

## Shape

```
StatefulSet cohort (replicas 1, OrderedReady)     one Pod per cohort
  init  install-config     Secret ns-config-<role> -> memory emptyDir, 0400, uid 1000
  init  vault-agent        native sidecar; Kubernetes auth; sink /run/ns-vault/token
  api, realtime, evaluator, tenant-admin          node deploy/multitenant/entrypoint.js <role>
  emptyDir ns-ipc at /run/ns-ipc                  serve.internal sockets, pod-private
Service api :1337, Service realtime :1339         the names nginx.conf's upstreams use
Deployment admin (Recreate)                       ADMIN_HOSTNAME=<pod IP>, :1342, acknowledged
Service admin (ClusterIP) + NetworkPolicy         operator Pods only; never the edge
Deployment ui, Service ui :1340
Deployment edge (nginx.conf byte for byte), Service edge :8080    the consumer entry
StatefulSet postgres, StatefulSet vault           same digests as compose.yaml
Job provision (backoffLimit 0)                    bootstrap -> vault-kubernetes-auth -> ownership-grants
NetworkPolicy                                     default deny ingress, then each Compose path
```

Three things the YAML does on purpose:

- **`enableServiceLinks: false` on every Pod.** Kubernetes would otherwise inject
  `API_PORT=tcp://<ip>:1337` (and `REALTIME_PORT`, `ADMIN_PORT`, `UI_PORT`) into every container
  of the namespace, and core reads `API_PORT` to work out the consumer listener even in roles that
  do not serve it (`lib/server/serve/listeners.js`). Read-derived; Compose injects no such variable.
- **Private documents and sockets live in a 0700 subdirectory.** `load-env.js` refuses a
  symlinked or group-readable `env.json`, and Secret volumes are both. An `emptyDir` root is
  root-owned, mode 3777 under `fsGroup` (measured), and core refuses that as the socket directory
  (`lib/server/internal-api/transport.js`, `SOCKET_IPC_DIRECTORY_REFUSED`). So the init step creates
  a 0700 subdirectory `d` owned by uid 1000 in each volume and copies the role's Secret into it as
  0400 files. Role containers mount only that subdirectory (`subPath: d`): their own documents
  read-only at `/run/ns-config`, and the shared sockets at `/run/ns-ipc`. Compose's `prepare.js`
  0700 directories give the same result.
- **The evaluator pool wiring uses core's names and is off in the preview.** Core reads
  `MULTITENANT_POOL_EVALUATOR_{PARTITION,MEMBERS,ORDINAL,LEASE_MS,DATABASE_URL,NAMESPACE}`
  (`lib/pool-membership/config.js`, branch `codex/pool-primitive-20261110`). With the partition off,
  core refuses any partitioned key ("partition is off but ... set"), so the preview renders none.
  `evaluatorPool.partition: 'on'` renders `PARTITION=on` and `ORDINAL` from the StatefulSet
  `apps.kubernetes.io/pod-index` label. The member count is the pool table's, set by an operator
  command, so no `MEMBERS` variable is rendered. Readiness stays the role health check and never
  depends on pool eligibility, which would deadlock `OrderedReady`. The renderer refuses any replica
  count other than 1.

## Requirements

Kubernetes 1.29 or newer (native sidecars; the pod-index label needs 1.28), a network plugin
that enforces NetworkPolicy, a default StorageClass, and a `kubectl` within one minor version
of the server. `tk` v0.20.0 renders and checks, but `tk apply` panics against `kubectl` v1.32
(`splitRow: slice bounds out of range` while reading `kubectl api-resources`), so the smoke applied
the committed render with `kubectl apply -f check/golden/preview.yaml`. The image is the Compose image built from core `16a1fc2d` with this repository's
Compose tree in place (`tools/compose-overlay.sh`, then the tree's `build.js`); its base
`config.js` must leave out the ownership identity, which the ownership overlay adds.

## Run (smoked on kind v0.27.0, Kubernetes v1.32.2)

```bash
commit=16a1fc2d45e59602eb6ec3e3bf6f506f35bcc5b1
docker tag nightscout-multitenant-demo:local nightscout-multitenant-demo:$commit
kind load docker-image nightscout-multitenant-demo:$commit            # or the cluster's equivalent

kubectl apply -f check/golden/preview.yaml          # or tk apply with a newer tk; Pods wait for the Secrets
scripts/secrets.sh seed nightscout-preview ../compose
kubectl -n nightscout-preview wait --for=condition=complete job/provision --timeout=10m
scripts/secrets.sh publish nightscout-preview nightscout-multitenant-demo:$commit
kubectl -n nightscout-preview rollout status statefulset/cohort
kubectl -n nightscout-preview port-forward svc/edge 18080:8080
kubectl delete -f check/golden/preview.yaml         # PVCs from volumeClaimTemplates stay until deleted
```

`spec.json` names `https://127.0.0.1:6443` as the API server; Tanka refuses to apply to any other.

## Checks

```bash
cd bindings/kubernetes
node check/invariants.js --compose <bindings/compose of the tree this binds>
node check/controls.js   --compose <same>
check/golden.sh
node --test check/vault-kubernetes-auth.test.js
```

`invariants.js` reads `../compose` by default. The preview renders core `16a1fc2d`; until the
Compose tree in this repository is synced to that commit, `postgres-identities-match-compose` is
red against it, and says so (identities `root_writer`, the `lifetime_*` roles and the ownership
overlay are missing, and the recorded commits differ).

| check | asserts | control (mutation -> message) |
|---|---|---|
| `internal-listener-not-on-service` | `ns-ipc` is an `emptyDir` in exactly one Pod template; no container sets `NS_SERVE_INTERNAL_HOST/PORT` or `NS_*_INTERNAL_URL`; every Service port targets a declared container port; no Service publishes an `int-*` port (bar `admin`) | `ns-ipc` as `hostPath` -> `volume ns-ipc must be a pod-private emptyDir, found hostPath`; realtime Service to `int-owner` -> `Service/realtime publishes internal port int-owner` |
| `admin-not-public` | no Ingress; the admin port only on `Service/admin`, `ClusterIP`, not the consumer entry; nginx.conf routes to neither plane; the admin Pods' NetworkPolicy admits operator Pods only | admin Service `LoadBalancer` -> `Service/admin exposes the admin port as LoadBalancer` |
| `secrets-by-reference` | no Secret rendered; no credential-named or credential-shaped literal env; no credential material in ConfigMaps; `/run/secrets` and `/run/ns-secret` mounts are Secret volumes | connection string in api env -> `env NS_API_PG is a literal; it must come from a Secret reference` |
| `images-pinned` | every image by `@sha256:` digest or an exact tag (semver or 40-hex commit) | `postgres:16` -> `image postgres:16 is not pinned by digest or exact tag` |
| `evaluator-statefulset` | the evaluator is in exactly one workload, a StatefulSet, replicas 1; partition off renders no `MULTITENANT_POOL_EVALUATOR_*` key; partition on renders `PARTITION=on` and `ORDINAL` from the pod-index label, never `MEMBERS`; readiness is the role health check only | ordinal with partition off -> `partition is off but the evaluator sets MULTITENANT_POOL_EVALUATOR_ORDINAL`; partition on with `metadata.name` -> `... ORDINAL must come from the StatefulSet pod-index label`; extra readiness argument -> `evaluator readiness must be the role health check only` |
| `private-directories` | role containers mount `ns-ipc` and their `config-*` volume at the 0700 subdirectory (`subPath: d`) | `ns-ipc` at its root -> `container api mounts ns-ipc at its root; mount the 0700 subdirectory (subPath d)` |
| `no-overlap-update` | StatefulSets `OrderedReady`, default one-at-a-time update, replicas 1; Deployments `Recreate` | `Parallel` -> `podManagementPolicy must be OrderedReady` |
| `service-links-off` | every Pod sets `enableServiceLinks: false` | `true` on the cohort -> `StatefulSet/cohort must set enableServiceLinks: false` |
| `postgres-identities-match-compose` | the per-workload PostgreSQL identities equal the Compose plan's per-role connection documents plus the ownership overlay's role, and the rendered core commit equals `../compose/SOURCE.md` | `root_writer` dropped from api -> `api: binding names alarm,api,lifetime_api,readiness, Compose names ...,root_writer` |

## Equivalence with the Compose binding

Status words: **rendered** (present in the render and covered by the offline checks), **smoked**
(applied to the kind cluster on 2026-11-10 and exercised; core `16a1fc2d`, image built with this
repository's Compose tree), **UNMEASURED** (neither, or a difference whose effect has not been
run). **Control red** means the smoke ran the control and it did not hold. The equivalence claim in
the deployment-bindings contract also waits on the trust probes (`DEPLOY-TRUST-PROBES`).

Two defects of the Compose tree at `16a1fc2d` stopped the smoke. Both reproduce here and both
belong to the Compose tree, not the binding; the smoke continued with a lab-only workaround, named
in each row:

- `config.js` gives `root_writer` no read of the lifecycle control schema, so the api exits
  (`LIFECYCLE_WINDOW_SCHEMA_UNSAFE` inside `SUBJECT_ADMIN_STORE_UNSAFE`). The bench lane's
  "Bench fix 1" (`bench/compose-baseline-20261110` `54af5f2`) is the fix; the smoke ran its grants
  by hand in the disposable database.
- The ownership overlay's `ownership-grants.js` writes `admin.json` without
  `ownership.lifecycleNamespace`, which core's `admin-config.js` requires, so admin exits
  ("invalid explicit admin operator configuration"). The smoke added the key (the control
  namespace) to the Secret by hand.

| Compose service or setting | Kubernetes counterpart | status |
|---|---|---|
| `postgres`: digest, `POSTGRES_DB`, password file, `pg_isready` healthcheck, named volume | StatefulSet `postgres`, Service `postgres`, Secret `ns-postgres-password`, PVC; `PGDATA` is a subdirectory of the volume (a fresh volume carries `lost+found`) | smoked |
| `vault`: digest, `vault server -config=demo.hcl`, TLS from the demo CA, status 0 or 2 is up | StatefulSet `vault`, ConfigMap `vault-config` (same `demo.hcl`), Secret `ns-vault-tls`; the probe dials loopback with `-tls-server-name=vault`, because the Service name has no endpoint until the probe passes | smoked (the first render probed `vault:8200` and never became Ready) |
| `prepare.js`: postgres password, demo CA and Vault certificate (SAN `vault`) | `scripts/secrets.sh seed`; the CA signing key is discarded instead of kept in state | smoked |
| `bootstrap` (profile `ops`) | Job `provision`, step `bootstrap`, same script and environment; output on PVC `provision-state` | smoked |
| `vault-agent-bootstrap` (AppRole) | step `vault-kubernetes-auth`: same policy and api rewrite, Kubernetes auth bound to service account `ns-cohort` and audience `vault` | smoked |
| `ownership-grants` (ownership overlay) | step `ownership-grants`, the overlay's script from ConfigMap `ownership-grants` made at apply time | smoked (10 grants); its `admin.json` is the overlay defect above |
| `vault-agent` service: uid 1000, AppRole files, sink 0600, healthy when the sink has a token | native sidecar in the cohort Pod, projected service-account token, same sink path, startup probe holds the roles | smoked (authenticated, token written, renewed) |
| `api`, `realtime`, `evaluator`, `tenant-admin` as four services | four containers of the cohort Pod, same image, command and environment document | smoked (api with the root_writer workaround) |
| shared `${NS_DEMO_STATE}/ipc` bind mount at `/run/ns-ipc` | `emptyDir` `ns-ipc` (memory), 0700 subdirectory at `/run/ns-ipc`, this Pod only | smoked (mounting the volume root was refused: `SOCKET_IPC_DIRECTORY_REFUSED` path) |
| per-role `${NS_DEMO_STATE}/<role>` read-only at `/run/ns-config` | Secret `ns-config-<role>` copied into a 0700 subdirectory of a memory `emptyDir`, read-only at `/run/ns-config` | smoked |
| `depends_on` api -> realtime -> evaluator (healthy) | not expressed: the role containers start together after the sidecar | smoked difference: realtime exits 78 once when it starts before api, then the in-place restart serves |
| `restart: "no"` | Pod `restartPolicy: Always` restarts one role container in place | UNMEASURED beyond the realtime restart above (incarnation and refusal semantics) |
| healthchecks (`health.js <role>`) | readiness probes, same script; no liveness probe | smoked |
| `read_only`, `cap_drop: ALL`, `no-new-privileges`, uid 1000, tmpfs `/tmp` | container securityContext, memory `emptyDir` at `/tmp`, seccomp `RuntimeDefault` | smoked |
| `admin`: `ADMIN_HOSTNAME=admin`, port 1342, acknowledgement, no published port, no nginx route | Deployment `admin`, `ADMIN_HOSTNAME` from `status.podIP`, Service `admin` ClusterIP, NetworkPolicy operator Pods only | smoked (`listOwners` listed 1 owner from an operator Pod; unlabelled Pod timed out) with the `admin.json` workaround |
| `ui` | Deployment `ui`, Service `ui` | smoked (Ready) |
| `nginx` published on `127.0.0.1:18080` | Deployment `edge`, ConfigMap with the same `nginx.conf`, Service `edge` ClusterIP | smoked (entry round-trip and Socket.IO through `edge`) |
| `demo` (profile `ops`, mounts the participant sockets) | not rendered. Ephemeral containers may not set `subPath` (API refusal, measured), and core refuses the volume root as socket directory, so an ephemeral container cannot reach the sockets either | UNMEASURED; needs a design |
| networks `backend` (internal) and `edge` | default-deny ingress plus one NetworkPolicy per Compose path; egress open | smoked: kindnet enforces; removing the policies opened admin to an unlabelled Pod |
| PostgreSQL identities per role | `inventory` in the renderer, compared with `config.js` and the ownership overlay | rendered; the identities connected in the smoke |
| one cohort; two cohorts of one deployment refuse to both serve | StatefulSet replicas 1, `OrderedReady`; the renderer refuses more | **control red**: scaled out of band to 2, `cohort-1` became 5/5 Ready, joined the `api` and `realtime` endpoints, and its evaluator started for both tenants |
| update without overlap | `OrderedReady`, delete-before-create | smoked once: `rollout restart` deleted `cohort-0` at 03:51:52Z and created the new one at 03:51:53Z |
| evaluator worker index | `MULTITENANT_POOL_EVALUATOR_ORDINAL` from the pod-index label when the partition is on; nothing when off | rendered; preview off |
