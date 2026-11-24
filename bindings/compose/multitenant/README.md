# Single-host multitenant Compose demonstration

This explicit synthetic deployment runs API, realtime, evaluator, tenant-admin
and the shipped web pages in separate containers. nginx presents one browser
origin. PostgreSQL and TLS-enabled Vault stay on the private network. It does
not change `nightscout single` or the existing Mongo Compose deployment.

The deployment uses synthetic tenants and generated private credentials. Keep
real records and identities out of this demonstration. Executed sources and
acceptance belong to the [alignment release record](https://github.com/bewest/rag-nightscout-ecosystem-alignment/blob/main/releases/cgm-remote-monitor-16.0.0/contents.md);
source checks do not establish restore acceptance.

[Fixed realtime workers and controlled moves](REALTIME.md) are an explicit M7
selection with their own deployment acceptance boundary. Preparation records
`NS_M7_DIAGNOSTICS` (default `0`) and `NS_M7_DIAGNOSTICS_INTERVAL_MS` (default
`5000`, range `1000..60000`). Selecting diagnostics passes these bounded settings
to the application containers. Pool occupancy and inclusive request timing are
diagnostic observations; missing samples remain unmeasured and their percentile
histograms do not establish causal ordering or exclusive application time.

## Prepare and start

Requirements: Docker Engine with Compose v2, Node.js, OpenSSL, and a host user
with uid/gid 1000 matching the image's `node` account. Use a dedicated checkout.
The image builds the production webpack bundle from that checkout's lockfile.
Preparation and build refuse modified tracked build inputs. The build takes a
Git archive of the recorded commit, so ignored runtime state and untracked files
cannot enter the image. A compatible patch can reuse the commissioned state through the stopped-fixture procedure below.
Runtime commands require the already-built image's source revision to match
that preparation. They never use a missing image as an implicit build request.

```bash
cd deploy/multitenant
./demo.sh prepare
node check-compose.js
./demo.sh build
./demo.sh up
./demo.sh status
./demo.sh demo
```

### Patch a seeded fixture

Seed a physical fixture once. After `./demo.sh up` and `NS_DEMO_TENANTS=8 ./demo.sh prime`,
`./demo.sh snapshot /absolute/new-fixture` stops the prepared project and copies the PostgreSQL
and Vault volumes, private state, TLS and primer credentials together. Keep the directory private.
From a clean overlay for the target commits, run
`./demo.sh restore-fixture /absolute/new-fixture --project new-lab --state /absolute/new-state --port 18081`.
Select the target image with `NS_DEMO_IMAGE` and run `./demo.sh up`. Bootstrap unseals Vault,
applies ordinary outstanding migrations and role grants; health checks govern startup. Use the
same compatible PostgreSQL and Vault storage versions. The restored DATA credentials are in
`primer/tenants.json` inside the new state directory. Commission restore authority only for
the explicit recovery drill or `./demo.sh demo`.

Overlaid on a core checkout by nightscout-deploy's `tools/compose-overlay.sh`,
this directory carries a marker (`.overlay.json`) naming the nightscout-deploy
commit it came from. Preparation and build then check core HEAD for every other
build input and that commit for this directory, byte for byte (only `.env`,
`.state` and the marker are left out); any other difference is still refused as
`BUILD_INPUTS_DIRTY`. The image is built from the two commits and labelled with
both (`org.opencontainers.image.revision`, `org.nightscout.deploy.revision`).

`prepare` seeds every credential before the first start (`credentials.js`: one PostgreSQL password
per role and the Vault token ids, under the private state's `credentials/`). `up` is one apply: the
one-shot `bootstrap` service writes each role’s mounted credential files (`render.js`), then
creates the schemas, roles, grants and Vault tokens from the same
credentials, and every role waits for it to complete (decision `provisioning-secrets-in`). A
repeat `up` renders again and finds the database already provisioned. `./demo.sh bootstrap` runs
the one-shot step alone. Run `./demo.sh prime` to populate the lab.
The `demo` command also runs this step before the two-tenant demonstration. The lab client provisions synthetic
tenants through admin, then creates
synthetic DATA subjects and samples.
The primer has no PostgreSQL or Vault credential. `commission-restore.js` is a
separate private DDL-operator step: it provisions current role-OID restore authority
only for active synthetic seed tenants, refuses existing revocations, and grants
no serving identity authority to modify that relation. The admin service composes
ownership operations and durable connector-source configuration on separate
database identities. Connector definitions contain secret references, never
plaintext endpoint credentials. The private operator resolves a requested tenant’s current lock key from PostgreSQL. The registry-backed operator format requires an active grant for that tenant and role for export, restore, and recovery. The two-tenant lab demonstration selects its synthetic clients independently.
The API marks each written tenant pending in its write transaction and sends a private hint
after commit. Evaluators recompute pending tenants on a hint or a periodic sweep, commit durable
evaluation work and hand completed output to realtime
over the private service boundary. Clinical reads stay on the evaluator's
registered storage connection; realtime reads typed completed output and current
presentation/control metadata. Partial setup is refused; source
and deployment revision changes require fresh synthetic state.

Serving roles report readiness on their private listener (`/healthz/ready`; Compose runs
`nightscout healthcheck --endpoint ready --socket /run/ns-ipc/<role>.sock`). Serving roles restart
on failure (`NS_COMPOSE_RESTART`, default `on-failure`; tests set `no` to hold a role down).
Realtime instances receive their slice as `NS_SLICE_ORDINAL` and `NS_SLICE_COUNT`. Evaluator
K>1 is not supported.

nginx waits only for the services it routes to, including each API instance.
An unhealthy evaluator or tenant-admin does not keep ingress down. Preparation
renders its read-only configuration from `nginx.compose.conf`, retaining Docker
DNS re-resolution and the selected per-client-IP budgets. `check-compose.js`
checks the template, private listener exposure and readiness dependencies.

For a restore, set `NS_MIGRATION_LARGEST_RELATION_BYTES` to the largest relation's heap
size. Bootstrap gives concurrent index builds max(60 s, ceil(bytes ÷
`NS_MIGRATION_BUILD_BYTES_PER_SECOND` × 3)). The default rate of 220,000,000 bytes/s
comes from a measured 13,110,624,256-byte heap indexed in 59.613 s on 2026-11-24.
`NS_MIGRATION_INDEX_BUILD_TIMEOUT_MS` can raise that budget up to 86,400,000 ms.
Core defaults to 1,800,000 ms when both inputs are omitted. Ordinary migration statements
use `NS_MIGRATION_STATEMENT_TIMEOUT_MS` (1–600,000 ms, default 60,000 ms).

`NS_POSTGRES_SHM_SIZE` (default `1g`) sizes PostgreSQL's `/dev/shm`. `check-compose.js`
requires at least 1 GiB, plus max(1, `max_parallel_maintenance_workers`) ×
`maintenance_work_mem` when the PostgreSQL command names `maintenance_work_mem`.

A failed bootstrap prints one JSON line on stderr: the stable `error` code, the
underlying `detail` message and the top stack frames (`at`). Connection-string
credentials, password clauses, Vault tokens, JWT-shaped strings and long hex
runs are redacted from both. Generated role configurations and environments use compact JSON.
`load-env.js` reads `env.json` with a fixed 1 MiB bound; the largest role document
measured 3.8 KB at 10,000 tenants.

The synthetic seed count (`NS_DEMO_TENANTS`) is any positive integer; there is no
fixed tenant ceiling (limits come from measurement). It is provisioning input. Runtime roles read tenant membership
and keys from the registry, not a copied tenant list. Realtime has no process-wide
socket cap; the edge budgets described below govern new handshakes and per-IP
connection/request concurrency.

The default public binding is `127.0.0.1:18080`. Add local name resolution for
the synthetic aliases declared in the generated public UI config, then use that
hostname in the browser. The two aliases select separate tenants at the same
origin port. Read the generated private operator environment only when you need
the synthetic browser token; keep it out of shell history, screenshots and logs.
This is a legacy subject credential. The stock browser and the restore-demo
client exchange it through `GET /api/v2/authorization/request/:accessToken`,
then send the returned JWT as the API3 Bearer credential. A raw legacy token
sent directly as API3 Bearer is refused. The exchange path contains a credential;
keep request URLs and transport errors out of logs.

To use an **already configured** dummy interface instead:

```bash
./demo.sh prepare --bind 169.254.1.1 --port 18080
```

Preparation verifies that the address exists; it never changes interfaces or
routes. Choose this before initial preparation. The directory and `.env` must
not already exist. nginx is the only published service. It joins an ordinary
edge bridge for host publication and the internal backend for its upstreams.
Every other service joins only the backend. Container loopback is
private to that container; other services communicate over the internal Docker
network or the fixed private Unix socket paths.

## Lab priming: one bulk call per batch

The primer makes tenants usable with one private admin call per 100 tenants
(decision `one-call-usable-provisioning`): `POST /v1/tenants/batch` with a
bootstrap block per tenant. Provisioning writes the role, owner, data subject
and its credential rows in each tenant's transaction and returns the data
subject's access token on `created`. The primer writes the roster from the
responses. It makes no tenant DATA API call, receives no PostgreSQL or Vault
credential, and loads no data (synthetic data belongs to the bench harness).

```bash
node deploy/multitenant/prime.js provision --tenant-count 1000 --concurrency 4
```

`--concurrency` (1 to 32, default 4) bounds batch calls in flight;
`--max-tenants` limits new tenants in this invocation (a partial run returns
`synthetic-tenants-partial` and exits 2). `prime` is the same idempotent call,
kept for callers that run `provision` then `prime`.

The only state is `tenants.json` (0600, rewritten atomically after every batch):
`{"version":1,"tenants":[{id,host,hosts,subject,dataToken?,jwt?,jwtExpiresAt?,ownerSubject,rootSecret?}]}`.
A tenant already in it is not sent again, so a completed run re-runs with no
traffic. Management sessions are not in the roster: they live at most 600 s;
issue one from `ownerSubject` at `POST /v1/tenants/{id}/management-sessions`
when a test needs it.

The legacy subject token (`dataToken`) is returned once, on `created`. Each result
also carries an 8-hour data JWT (`jwt`, `jwtExpiresAt`), signed in process from the
deployment signing secret on both `created` and `existing`. If a batch response is
lost before the roster write, the retry's `existing` answers are saved from their JWT
(no `dataToken`); only a tenant answered with no credential at all refuses with
`PRIMER_CREDENTIAL_NOT_RETURNED` and their count. One
process owns the directory through `prime.lock`. Diagnostics carry codes and
counts only.

## Credentials and initialization

Each runtime service mounts only its own generated read-only configuration
directory. The UI and nginx receive no database credentials. Only the one-shot
bootstrap mounts the full private output directory and initial database/Vault
material. The private admin uses narrowly scoped provisioning credentials; the
lab primer receives only its seed and API-issued synthetic credentials. The
separate operator demonstration mounts only its operational
configuration, artifact directory and participant sockets.

Vault's server certificate is issued by a local, short-lived demo CA. Runtime
containers receive the public CA certificate; the signing key and Vault
initialization material stay in the private host state. This lab uses a
single-share Vault initialization ceremony. Use your deployment's established
key custody and recovery process for real operation.

The schema owner, migration identity, read-only readiness identity, clinical API
writer, realtime reader, evaluator durable-state capabilities, owner management
and maintenance operator have different responsibilities. See `CREDENTIALS.md`
for the actual generated privilege inventory. A runtime service must never reuse
the bootstrap administrator. PostgreSQL RLS remains enabled for serving roles.

The database and Vault use named volumes. nginx has no route to platform-admin,
tenant-admin or restore-control endpoints. Tenant management is initially
available only through the private service boundary. Private Unix sockets use a
shared uid, mode-0700 directory and mode-0600 endpoints; only the participating
roles and maintenance operator mount that directory. This is fixed single-host
composition, not dynamic replica discovery.

Image references are immutable digests. PostgreSQL readiness probes connect to
the final TCP server and the separate `postgres` maintenance database, so a probe
does not accept the socket-only initialization server or become an
unregistered administrator in the application's restore-session census. Both
Vault image-declared storage paths have explicit volumes; no anonymous volume
is needed. The scoped demo Vault credentials expire after 24 hours; restart does
not renew them. The separately configured Vault Agent binding supplies renewable
service credentials for deployment trust acceptance.

## Tenant-local restore demonstration

`demo.sh demo` exercises the actual REST and lifecycle/controller modules. The
intended observation is: capture A, alter A, restore A through the participating
services, observe B completing an independent write while A is held, and verify
restored A plus forward history corrections without changing B's prior state.
The operator must retain the actual source's transaction, authority and clock
checks. An uncertain outcome or missing participant must refuse; do not clear
maintenance state or force reopening to make the demonstration finish.

See the canonical [failure recovery and shared-role restart boundary](../../docs/tenant-operation-cohort.md#failure-recovery-and-shared-role-restart-boundary).
B's continued work during a restore on a running cohort does not establish
independent B restart or high availability when A remains suspended. Do not
restart the whole shared cohort as a substitute for resolving uncertain state.

Artifacts remain in the private state directory. They include synthetic
clinical records and metadata; do not commit generated state or credentials.

## Web UI and human login

The UI service renders the shipped templates and serves the production browser
bundle. The existing browser talks to same-origin API and Socket.IO routes.
The UI service does not query PostgreSQL or decide a user's authority. Tenant
public configuration is a narrow validated projection, not an exported runtime
environment. Editor pages do not imply that every operator/integration feature
has been admitted in the preview.

Shared optional OIDC for single and multitenant modes is an independent feature.
The base Compose file leaves login/callback/session configuration disabled.
The separately opted-in [Authentik profile](../../../providers/identity/authentik/README.md)
prepares the existing registry OIDC path and bounded provider/Host/TLS probes;
actual real-provider qualification remains UNMEASURED.
Both modes should use the same provider protocol with their own current local
authorization adapters. Existing machine credentials remain compatible.

Recommended responsibility split: Nightscout provides its sign-in entry point,
callback/session/logout handling and permission mapping; an interchangeable
identity provider supplies sign-in, MFA and account recovery screens. A service
provider may supply its own identity UI through that provider contract. A
first-party password/recovery UI is not required. Authentik can be a self-managed
OIDC reference; Clerk can be a managed option. Neither is a mandatory dependency
or accepted adapter in this demo. Provider authentication alone must never grant
tenant membership or management authority.

## Stop and retain evidence

```bash
./demo.sh stop
./demo.sh down
```

These commands retain data volumes and private state. Delete them only after
checking the exact project and saving any wanted synthetic evidence.
Vault health reports `VAULT_SEALED` when the initialized fixture is sealed. Run `./demo.sh bootstrap`
with the retained private state to unseal it before runtime roles start again. Do not delete sockets
while participating services are running. The initial demo CA expires after
30 days; rebuild a fresh synthetic instance rather than disabling verification.

## Fixed API instances and edge budgets

`NS_API_REPLICAS` selects 1..16 equal API instances in this synthetic binding.
Set it for `demo.sh prepare`; preparation records it and renders the fixed Compose
placement. One instance keeps the original local-socket placement. Multiple instances
use one private service address, while maintenance pins every exact instance address.
Changing the roster requires preparing a new deployment; do not use Compose scaling
behind an unchanged maintenance roster. Only nginx publishes a host port.

The edge applies per-client-IP connection/request concurrency and new Engine.IO
handshake budgets. Configure `NS_EDGE_CONNECTIONS_PER_IP`,
`NS_EDGE_HANDSHAKES_PER_SECOND`, and `NS_EDGE_HANDSHAKE_BURST` at preparation.
The synthetic defaults are 50,000 concurrent connections/requests per IP,
5,000 new handshakes per second, and burst 10,000. They are test-binding defaults,
not measured production limits. Established Engine.IO sessions do not consume the
new-handshake rate budget. Refusal returns 429 at the edge; there is no application
process-wide socket cap. Record these settings in capacity results and size them
for the deployment, including clients sharing an egress address.
`NS_EDGE_WORKER_CONNECTIONS` independently sets nginx connections per worker
(default 16,384, range 128..32,768); these slots include upstream connections.
The container supplies a 65,536 file-descriptor soft/hard limit per process.
This replaces the template's fixed 1,024-slot renderer input, which could bound
viewer capacity before the per-IP policy. These are synthetic reference resource
budgets; the capacity campaign must measure the resulting envelope.

## Prediction curve cap

`PREDICTIONS_MAX_SIZE` is the single-site setting: the most points kept in each OpenAPS
prediction curve (`predBGs` IOB, COB, UAM, ZT) when a device status arrives through API v1.
Set it in the shell or in `.env`. It reaches the `api` service and every API instance, and core gives
every tenant that one value, with the single-site rules: unset, empty or invalid is `288`, `0`
keeps whole curves. It is not a tenant setting. API v3 and socket writes keep whole curves, as on
a single site. `check-compose.js` refuses a configuration where `api` does not receive it.

## Clinical isolation from REST saturation

`clinical-isolation.js` keeps clinical delivery working when REST traffic exceeds
what the API can serve. Values are selected for `demo.sh prepare` and recorded in `.env`.

REST admission is opt-in. When `NS_API_REST_CONCURRENCY` is unset or empty, preparation
renders no `NS_API_REST_*` value and each API process admits every REST request, as core
does. A fixed small bound sheds normal traffic: at 180 requests/s with a p95 of about
0.4 s, about 70 requests are in flight. Size a bound from measured traffic before you set
one. Only the values you set are rendered; core supplies the defaults shown for the others.
A queue, timeout or Retry-After value without a concurrency is refused at preparation.

| Setting | Default | Effect |
|---|---|---|
| `NS_API_REST_CONCURRENCY` | unset (no limit) | REST requests one API process runs at once (core `lib/server/serve/rest-admission.js`) |
| `NS_API_REST_QUEUE` | core: 0 | requests that may wait for a slot; others get 503 `REST_ADMISSION_REFUSED` |
| `NS_API_REST_QUEUE_TIMEOUT_MS` | core: 1000 | longest wait for a slot before the 503 |
| `NS_API_REST_RETRY_AFTER_SECONDS` | core: 1 | `Retry-After` on the 503 |
| `NS_POSTGRES_MAX_CONNECTIONS` | 140, or more when the declared pool budget needs it | PostgreSQL `max_connections`. Unset, it is sized to hold 3 superuser slots, the clinical reservation and the role pools (`NS_POOL_<ROLE>_MAX` x processes: api x replicas, realtime x workers, evaluator + receiver + operation x evaluator workers), never below 140 |
| `NS_POSTGRES_CLINICAL_RESERVED_CONNECTIONS` | 40 | PostgreSQL `reserved_connections` |

When a limit is set, a refused request runs no handler, so a refused write has no
storage effect. The limit counts only the API's public listener; `serve.internal`
(socket authority for realtime, lifecycle status) and realtime sockets are not counted.

Bootstrap grants `pg_use_reserved_connections` to the evaluator, realtime,
outbox, suppression and evaluator/realtime lifetime roles only. The API, admin, UI
and the shared display/activity reader roles cannot use the reserved slots. The
defaults keep the 97 general slots of PostgreSQL's default configuration and add 40
clinical slots. They are synthetic reference values derived from declared pool
sizes, not measured capacity; size the reserve for realtime/evaluator worker
overlays.

Generated edge and replica files live in private deployment state. Their input
policy changes take effect through explicit preparation rather than mutating running
role authority or silently changing the fixed maintenance census.

Registry role operation configurations select four bounded marker sessions per
worker. `NS_OPERATION_LEASE_SESSIONS` at preparation can select another positive
count within the configured operation pool; preparation records the choice.
These sessions serialize short registration/completion sections while response
lifetimes and restore exclusion remain protected. Unselected application profiles
retain their prior operation path. Four is a synthetic measurement profile, not
a portable throughput claim; record it alongside the pool sizes.

The maintained evaluator owns input/control capture and durable evaluation work.
Realtime consumes its typed completed output and durable delivery receipts. The
same committed registry/settings authority builds both roles' tenant identities.
Realtime reads current presentation/control metadata on addressed work, and
retains bounded startup, recovery and failed-delivery work. Warm tenants have no
periodic discovery sweep. Fixed capture health checks are separate from actual
clinical due instants and realtime delivery retries. The deployment provisions
independent realtime receipt, evaluator clinical checkpoint and typed completed
output rows; restore inventory includes their selected catalogue families.

The opted-in `shipping-sharding.integration.test.js` first proves every fixed API
instance × synthetic seed tenant through a private, authorized status GET. A bare
readiness client uses only a short-lived mode-0600 DATA-credential input and three
read-only fixture/input mounts; it receives no operator, database, Vault or IPC
configuration. Its single 20-second request-phase budget permits only typed
`TENANT_WARMING` responses to remain pending. A 200 response must be an object with `status: 'ok'`
and no error field; malformed/error-bearing successes fail setup, as do other
refusals. No JWT exchange, socket admission or clinical write precedes this barrier. Metadata inspection and
client cleanup each have separate bounded commands outside that request phase.
Successful probes are followed by another exact roster inspection: changed or lost
container ID, boot time, image or ownership/source labels refuse the barrier.

The restore interval keeps the four original public-edge B status readers.
Each must have succeeded before restore starts; every subsequent non-200 or
transport failure still fails continuity. `api-readiness.json` records exact
instance identities and tuple readiness. `settings-continuity.json` records bounded
sanitized request chronology, first successes and restore spawn/exit stages.
Public-edge requests explicitly retain unknown upstream-instance attribution.
These artifacts contain no credentials, request URLs or response bodies. The
fixture retains its 120-second total timeout and existing request/restore cadence.

Run the focused host-fixture checks without activating Docker:

```sh
node bindings/compose/multitenant/api-readiness-observation.test.js
node bindings/compose/multitenant/api-readiness-host.test.js
node bindings/compose/multitenant/api-readiness-sequence.test.js
NS_UI_TEST_CORE=/absolute/core/worktree node bindings/compose/multitenant/api-readiness-carrier.test.js
```

The last check uses the actual source credential derivation, DATA middleware and
status handler with synthetic recording store/provider ports and disposable HTTP
listeners. It is distinct from native PostgreSQL/Compose acceptance. The existing
shipping native suite remains explicitly selected by `NS_COMPOSE_SHARDING_STATE`;
unselected native runs are skipped, never evidence that a deployment passed.

### Explicit synthetic incremental commissioning

Write a private `primer/add.json` in the prepared state directory with
`{"version":1,"tenants":[...]}`. Each tenant is an ordinary provisioning request
(`id`, `hosts`, `issueRootSecret: true`); at most 100. Run
`node deploy/multitenant/prime.js add` in the existing Compose primer service.
New tenants are provisioned with the same bootstrap and appended to
`tenants.json`; tenants already in it are not touched. A refused tenant stops
the run with its code after its peers are saved; correct only that request and
retry with the same tenant ids.

`shipping-live-add.integration.test.js` is an opt-in, mutating synthetic
qualification on a fresh disposable project, never an existing benchmark or
retained stack. It requires `NS_SHIPPING_LIVE_ADD_STATE`,
`NS_SHIPPING_LIVE_ADD_CORE`, `NS_SHIPPING_LIVE_ADD_PROJECT` (prefix
`ns-live-add-proof-YYYYMMDD`) and exact `NS_SHIPPING_LIVE_ADD_IMAGE`. It checks
actual source/image/project identity before running the primer fixture. The
fixture intentionally produces an existing-tenant host conflict alongside one
successful new tenant, preserves root custody, explicitly retries that same new
ID, commissions it through the actual APIs, and verifies registered edge reads,
wrong-tenant denial, private-route refusal and existing clinical-row continuity.
Its private once-only journal refuses a repeated qualification run. It performs
no container lifecycle, SQL seeding, membership or settings mutation. A skipped
native test is UNMEASURED, not deployment acceptance.


## Fixed native evaluator processes

Set `NS_EVALUATOR_WORKERS` during preparation
to opt in to a fixed roster of 1–32 processes. Leaving it unset keeps the
standalone evaluator. `NS_REALTIME_WORKERS` (1–8) is selected independently; the two counts need not be equal. This example starts two evaluator processes and provisions two synthetic tenants.

```bash
NS_EVALUATOR_WORKERS=2 ./demo.sh prepare
./demo.sh config
./demo.sh build
./demo.sh up
```

Each process owns a tenant slice selected by core's SHA-256 modulo rule. An idle
slice can receive a newly provisioned tenant. Set `NS_DEMO_TENANTS` when running the lab
client to select the synthetic population. Each evaluator has its
own private listener and readiness identity. A diagnostic Compose override may set CPU or
memory limits for selected workers. Evaluator and operation pools are
bounded at four and eight connections per process respectively.

