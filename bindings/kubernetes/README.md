# Kubernetes binding

*Contributor- and operator-facing. State 2026-11-10: rendered and checked offline; not yet applied
to a cluster. Every row of the equivalence table below says which.*

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
- **Private documents are copied, not mounted.** `load-env.js` refuses a symlinked or
  group-readable `env.json`; Secret volumes are both. An init step copies each role's Secret into a
  memory-backed `emptyDir` as regular 0400 files owned by uid 1000, and each role container mounts
  only its own directory read-only at `/run/ns-config`, as in Compose.
- **The evaluator's pool wiring is rendered, flag-off.** `NS_EVALUATOR_POOL_ORDINAL` comes from the
  StatefulSet `apps.kubernetes.io/pod-index` label and `NS_EVALUATOR_POOL_MEMBERS` from the replica
  count. The names are provisional until core's `MT-POOL-PRIMITIVE` lands; core ignores both
  today. The renderer refuses any replica count other than 1.

## Requirements

Kubernetes 1.29 or newer (native sidecars; the pod-index label needs 1.28), a network plugin
that enforces NetworkPolicy, a default StorageClass, `tk` and a `kubectl` within one minor version
of the server. The image is the Compose image built from core `16a1fc2d` with this repository's
Compose tree in place (`tools/compose-overlay.sh`, then the tree's `build.js`); its base
`config.js` must leave out the ownership identity, which the ownership overlay adds.

## Run (not yet exercised on a cluster)

```bash
commit=16a1fc2d45e59602eb6ec3e3bf6f506f35bcc5b1
docker tag nightscout-multitenant-demo:local nightscout-multitenant-demo:$commit
kind load docker-image nightscout-multitenant-demo:$commit            # or the cluster's equivalent

tk apply environments/preview                       # Pods wait for the Secrets that do not exist yet
scripts/secrets.sh seed nightscout-preview ../compose
kubectl -n nightscout-preview wait --for=condition=complete job/provision --timeout=10m
scripts/secrets.sh publish nightscout-preview nightscout-multitenant-demo:$commit
kubectl -n nightscout-preview rollout status statefulset/cohort
kubectl -n nightscout-preview port-forward svc/edge 18080:8080
tk delete environments/preview                      # PVCs from volumeClaimTemplates stay until deleted
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
| `evaluator-statefulset` | the evaluator is in exactly one workload, a StatefulSet, replicas 1, ordinal from the pod-index label, members equal to replicas | ordinal env removed -> `must come from the StatefulSet pod-index label` |
| `no-overlap-update` | StatefulSets `OrderedReady`, default one-at-a-time update, replicas 1; Deployments `Recreate` | `Parallel` -> `podManagementPolicy must be OrderedReady` |
| `service-links-off` | every Pod sets `enableServiceLinks: false` | `true` on the cohort -> `StatefulSet/cohort must set enableServiceLinks: false` |
| `postgres-identities-match-compose` | the per-workload PostgreSQL identities equal the Compose plan's per-role connection documents plus the ownership overlay's role, and the rendered core commit equals `../compose/SOURCE.md` | `root_writer` dropped from api -> `api: binding names alarm,api,lifetime_api,readiness, Compose names ...,root_writer` |

## Equivalence with the Compose binding

Status words: **rendered** (present in the render and covered by the offline checks), **smoked**
(applied to a cluster and exercised), **UNMEASURED** (neither, or a difference whose effect has
not been run). No row is smoked yet. The equivalence claim in the deployment-bindings contract
also waits on the trust probes (`DEPLOY-TRUST-PROBES`).

| Compose service or setting | Kubernetes counterpart | status |
|---|---|---|
| `postgres`: digest, `POSTGRES_DB`, password file, `pg_isready` healthcheck, named volume | StatefulSet `postgres`, Service `postgres`, Secret `ns-postgres-password`, PVC; `PGDATA` is a subdirectory of the volume (a fresh volume carries `lost+found`) | rendered |
| `vault`: digest, `vault server -config=demo.hcl`, TLS from the demo CA, status 0 or 2 is up | StatefulSet `vault`, ConfigMap `vault-config` (same `demo.hcl`), Secret `ns-vault-tls`, same probe | rendered |
| `prepare.js`: postgres password, demo CA and Vault certificate (SAN `vault`) | `scripts/secrets.sh seed`; the CA signing key is discarded instead of kept in state | rendered |
| `bootstrap` (profile `ops`) | Job `provision`, step `bootstrap`, same script and environment; output on PVC `provision-state` | rendered |
| `vault-agent-bootstrap` (AppRole) | step `vault-kubernetes-auth`: same policy and api rewrite, Kubernetes auth bound to service account `ns-cohort` and audience `vault` | rendered; offline test 3/3, ablation red |
| `ownership-grants` (ownership overlay) | step `ownership-grants`, the overlay's script from ConfigMap `ownership-grants` made at apply time | rendered |
| `vault-agent` service: uid 1000, AppRole files, sink 0600, healthy when the sink has a token | native sidecar in the cohort Pod, projected service-account token, same sink path, startup probe holds the roles | rendered |
| `api`, `realtime`, `evaluator`, `tenant-admin` as four services | four containers of the cohort Pod, same image, command and environment document | rendered |
| shared `${NS_DEMO_STATE}/ipc` bind mount at `/run/ns-ipc` | `emptyDir` `ns-ipc` (memory) at `/run/ns-ipc`, this Pod only | rendered |
| per-role `${NS_DEMO_STATE}/<role>` read-only at `/run/ns-config` | Secret `ns-config-<role>` copied to a memory `emptyDir`, read-only at `/run/ns-config` | rendered |
| `depends_on` api -> realtime -> evaluator (healthy) | not expressed: the role containers start together after the sidecar | UNMEASURED difference |
| `restart: "no"` | Pod `restartPolicy: Always` restarts one role container in place | UNMEASURED difference (incarnation and refusal semantics on container restart) |
| healthchecks (`health.js <role>`) | readiness probes, same script; no liveness probe | rendered |
| `read_only`, `cap_drop: ALL`, `no-new-privileges`, uid 1000, tmpfs `/tmp` | container securityContext, memory `emptyDir` at `/tmp`, seccomp `RuntimeDefault` | rendered |
| `admin`: `ADMIN_HOSTNAME=admin`, port 1342, acknowledgement, no published port, no nginx route | Deployment `admin`, `ADMIN_HOSTNAME` from `status.podIP`, Service `admin` ClusterIP, NetworkPolicy operator Pods only | rendered |
| `ui` | Deployment `ui`, Service `ui` | rendered |
| `nginx` published on `127.0.0.1:18080` | Deployment `edge`, ConfigMap with the same `nginx.conf`, Service `edge` ClusterIP plus `port-forward` | rendered |
| `demo` (profile `ops`, mounts the participant sockets) | not rendered: a separate Pod cannot share the sockets; the counterpart is an ephemeral container in the cohort Pod | UNMEASURED |
| networks `backend` (internal) and `edge` | default-deny ingress plus one NetworkPolicy per Compose path; egress open | rendered (enforcement depends on the network plugin) |
| PostgreSQL identities per role | `inventory` in the renderer, compared with `config.js` and the ownership overlay | rendered |
| one cohort; two cohorts of one deployment refuse to both serve | StatefulSet replicas 1, `OrderedReady`; the renderer refuses more | rendered; the two-Pod refusal control UNMEASURED |
| evaluator worker index and member count | pod-index label and replica count | rendered (provisional names, flag not in core) |
