# Single-host multitenant Compose demonstration

This explicit synthetic deployment runs API, realtime, evaluator, pgstream, tenant-admin
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
cannot enter the image. Re-run preparation in a fresh deployment state when the
source commit changes.
Runtime commands require the already-built image's source revision to match
that preparation. They never use a missing image as an implicit build request.

```bash
cd deploy/multitenant
./demo.sh prepare
node check-compose.js
./demo.sh build
./demo.sh bootstrap
./demo.sh up
./demo.sh status
./demo.sh demo
```

Overlaid on a core checkout by nightscout-deploy's `tools/compose-overlay.sh`,
this directory carries a marker (`.overlay.json`) naming the nightscout-deploy
commit it came from. Preparation and build then check core HEAD for every other
build input and that commit for this directory, byte for byte (only `.env`,
`.state` and the marker are left out); any other difference is still refused as
`BUILD_INPUTS_DIRTY`. The image is built from the two commits and labelled with
both (`org.opencontainers.image.revision`, `org.nightscout.deploy.revision`).

`bootstrap` prepares infrastructure only: schemas, grants, role configurations,
the private admin service and maintained pgstream capture metadata. `up` starts the private admin,
provisions the seed through its versioned API, explicitly commissions the private
restore operator for that synthetic cohort, verifies platform state through the
private admin API, starts the API instances, and runs
a separate lab-priming API client before starting realtime/evaluator and ingress.
The primer has no PostgreSQL or Vault credential. `commission-restore.js` is a
separate private DDL-operator step: it provisions current role-OID restore authority
only for active synthetic seed tenants, refuses existing revocations, and grants
no serving identity authority to modify that relation. The admin service composes
ownership operations and durable connector-source configuration on separate
database identities. Connector definitions contain secret references, never
plaintext endpoint credentials. The private restore operator uses the same exact registry cohort label as the
serving participants; the synthetic seed list selects demonstration tenants.
The separate pgstream service owns capture through its registered stream login.
The platform restarts that worker independently; its wire credentials are mounted
only in the pgstream container. Evaluators accept the private stream at their
admitted endpoints, commit durable evaluation work and hand completed output to realtime
over the private service boundary. Clinical reads stay on the evaluator's
registered storage connection; realtime reads typed completed output and current
presentation/control metadata. Partial setup is refused; source
and deployment revision changes require fresh synthetic state.

Each native `run` invocation can wait for its explicitly configured receiver
transport before opening a health source pool, initializing or consuming WAL.
The generated configuration selects `pgstream.startupTransport` with
`timeoutMs: 300000` and `retryIntervalMs: 50`. These positive integer settings are
overridable in a newly prepared configuration. They produce the separate
`target.webhooks.startup_transport` wire document with the canonical ordered
receiver roster. An absent option preserves the previous native startup path.

The wait requires every selected receiver to answer GET `/pgstream/ready` with
204. This checks HTTP listener and checkpoint-store ownership; source admission,
schema verification, clinical completion and whole-role health follow their
existing checks. Only typed dial connection refusal retries within the selected
startup budget. Other HTTP/network refusals and cancellation stop startup. After
success, the startup wait ends; delivery retains its existing strict retry and
checkpoint behavior. Startup, notifier acknowledgment, clinical and controller
convergence clocks remain separate. A future controller must allow the selected
startup and schema/acknowledgment work plus its stability observation within the
remaining outer work and cleanup windows. Existing prepared runs remain frozen.

The admin service owns platform schema, catalogue and privilege verification.
`platform-startup.js` writes the selected verification namespace and role into
serving configuration and copies each role's exact configuration, environment
and operation context into admin's private mount. The verification writer
credential stays there.

**Pre-start platform step.** Before starting the API, `up` runs
`node deploy/multitenant/platform-verify.js` in the primer container, after
migrations and restore commissioning. That job sends `{}` to the private
`POST /v1/platform-verification` operation. A Job or controller can call the
same operation through its private network access. The admin role verifies
migrations, schema, grants, ownership and catalogues for every serving role
once and issues the platform proof. The job records the selected-operation hash
and verified role generations in `primer/platform-verification.json`; a refused
or incomplete verification stops startup, and no serving role starts.

Each serving role (api, evaluator, realtime) checks the proof once at start: it
must be present and match the role, database and contract. Otherwise the role
exits with `PLATFORM_VERIFICATION_REQUIRED` (or
`PLATFORM_SERVING_IDENTITY_UNSAFE` for an unsafe login). The proof has no lease
and no refresh: a serving role never re-verifies, polls or refuses requests
because of it while it runs. A datastore restart does not invalidate it.
Authority drift after start is detected at the next start, so run the
pre-start step again after any schema, grant or ownership change and before
restarting serving roles. Before a known schema or grant change, the platform
sends `{}` to private `DELETE /v1/platform-verification`; that operation
revokes the proof and fences any older in-flight verifier, so a role that
starts during the change refuses. The platform then changes the schema or
grants and runs the pre-start step again.

nginx waits only for the services it routes to, including each API instance.
An unhealthy evaluator or tenant-admin does not keep ingress down. Preparation
renders its read-only configuration from `nginx.compose.conf`, retaining Docker
DNS re-resolution and the selected per-client-IP budgets. `check-compose.js`
checks the template, private listener exposure and readiness dependencies.

A failed bootstrap prints one JSON line on stderr: the stable `error` code, the
underlying `detail` message and the top stack frames (`at`). Connection-string
credentials, password clauses, Vault tokens, JWT-shaped strings and long hex
runs are redacted from both. Generated role documents (configuration,
environment, admission) are written as compact JSON. For large tenant counts,
`NS_BOOTSTRAP_CONFIG_MAX_BYTES` (off when empty; 65,536 to 67,108,864) is passed
by Compose to every role container, and to the ownership overlay's admin, as
core's `MULTITENANT_CONFIG_MAX_BYTES`, and the bootstrap validates the files it
writes against the same value. It never enters `env.json`. `load-env.js` takes its
bound on `env.json` from core's reader (`lib/server/serve/config-file.js`), and
keeps the fixed 1 MiB bound with a core that has no such module.

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

## Bounded lab priming

The primer keeps each tenant's existing authorized API sequence serial. Its
optional worker count overlaps independent tenants; the default remains one.
It receives no PostgreSQL or Vault credentials and does not bypass public DATA
or private ownership/session authorization.

Primer failures retain an allowlisted connection cause and request class.
They omit request URLs, tenant identities, headers and bodies. The first
successful role-list read emits one `first-useful-response` event with a wall
clock timestamp; full priming emits a separate `completed` event. Process
readiness, first useful service and completed lab priming therefore remain
separate observations. Only the existing explicit `TENANT_WARMING` read retry
is automatic; an uncertain entry write keeps its reconciliation fence.

Within the existing primer environment, a bounded chunk is:

```bash
node deploy/multitenant/prime.js prime --concurrency 4 --max-tenants 100
```

`prime` and `add` accept these options. `--concurrency` is an integer from 1 to
32; `--max-tenants` is an integer from 1 to 10000 and limits new commissioning in
this invocation. The values are operational bounds, not measured capacity.
A partial chunk returns `synthetic-data-prime-partial` with completed and
remaining counts and exits 2. An explicit next invocation skips completed
tenants without API traffic, credential renewal or another entry upload.
Existing `primed.json` describes its prior completed seed until all newly
provisioned tenants finish.

One process owns the directory through `prime.lock` across `provision`, `prime`
and `add`. Shared custody updates are synchronous, atomically renamed and
flushed, including the parent directory. Parallel workers cannot overwrite a
peer's completed tenant or management request identity. On a tenant failure or
SIGINT/SIGTERM, dispatch stops and already-started tenants drain under their
existing request and warming timeouts. Hard process termination can interrupt
that drain. A retained lock is never silently stolen: first confirm its process
is absent and review pending outcomes before removing it.

Before an entry POST, `entry-requests.json` records an `outcome-uncertain` phase.
The record is cleared only after a definite client refusal or after the tenant's
completed custody is flushed. Transport loss, server errors or failed local
completion writes retain the phase. Resume then refuses with
`PRIMER_ENTRY_OUTCOME_UNCERTAIN` before any API traffic. Reconcile through the
authorized API and retained request evidence; do not clear the phase to force a
retry. The primer recomputes entry time on retry and does not establish identical
replay or read-back semantics; the entry label alone does not resolve an
uncertain completion. Completed tenants are reusable, but ambiguous entry outcomes
are not automatically replayed.

The existing `add` operation remains limited to 100 explicit tenant specs per
addition. It provisions through the private tenant API and commissions only
unfinished tenants. Reusing a cohort does not authorize resetting its stream,
changing source/image pins, replacing credentials or changing its observation
window. Higher worker counts can increase database contention and custody I/O;
measure their effects before choosing later scale points.

This primer change needs a new deployment pin and canonical image qualification
before adoption. Focused loopback tests establish scheduling and custody
behavior; they do not establish live throughput, power-loss behavior of the
filesystem or clinical correctness.

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
checking the exact project and saving any wanted synthetic evidence. A stopped
Vault must be unsealed before runtime roles start again. Do not delete sockets
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
| `NS_POSTGRES_MAX_CONNECTIONS` | 140 | PostgreSQL `max_connections` |
| `NS_POSTGRES_CLINICAL_RESERVED_CONNECTIONS` | 40 | PostgreSQL `reserved_connections` |

When a limit is set, a refused request runs no handler, so a refused write has no
storage effect. The limit counts only the API's public listener; `serve.internal`
(socket authority for realtime, lifecycle status) and realtime sockets are not counted.

Bootstrap grants `pg_use_reserved_connections` to the pgstream, evaluator, realtime,
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

The lab/qualification primer can commission additional synthetic tenants through
existing private provisioning, ownership and management-session issuance APIs.
It has no database or Vault credential. This adapter is separate from the
shipping operator authority APIs. Registry mode already sets runtime/UI tenant
ceilings to 10,000 independently of the seed count; no reserve flag is needed.

Write a private `primer/add.json` in the prepared state directory with
`{"version":1,"tenants":[...]}`. Each tenant is an ordinary provisioning request
(`id`, `hosts`, `issueRootSecret: true`); at most 100 requests are admitted. Run
`node deploy/multitenant/prime.js add` in the existing Compose primer service,
using the same prepared overlay selection. Output contains counts only. Keep
this file and all primer custody private (0600).

A refused batch preserves successfully issued roots before stopping. Correct
only the refused request and explicitly retry; reuse the same tenant IDs.
An ambiguous response without locally retained root custody refuses rather than
replacing the credential. Commissioning resumes unfinished tenants with their
persisted management request IDs. Previously completed tenants are skipped:
no clinical re-upload, implicit credential renewal or ownership reassignment.
A global `primed.json` marker never suppresses new-tenant commissioning.
Pause/suspend qualification is a separate deferred stage.

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

Prepare fresh synthetic state with a core revision that accepts
`NS_PGSTREAM_EVALUATOR_PROCESSES`. Set `NS_EVALUATOR_WORKERS` during preparation
to opt in to a fixed roster of 1–8 processes. Leaving it unset keeps the
standalone evaluator. This example provisions two synthetic tenants before
starting their two evaluator processes.

```bash
NS_EVALUATOR_WORKERS=2 ./demo.sh prepare
./demo.sh config
./demo.sh build
./demo.sh up
```

Each process owns a nonempty tenant slice selected by core's SHA-256 modulo
rule. Preparation refuses a seed count that leaves a slice empty. Set
`NS_DEMO_TENANTS` during preparation when the selected count requires more
seed tenants. The generated overlay binds both counts. Each evaluator has its
own private listener and readiness identity, one CPU and 1 GiB of memory.
The producer has one CPU and 512 MiB. Evaluator and operation pools are
bounded at four and eight connections per process respectively. PostgreSQL
keeps one persistent producer slot and permits bounded snapshot recovery.

The producer registers every receiver for every input table and transaction
boundary. It advances the source checkpoint only after all receivers acknowledge
a cohort. An evaluator can finish accepted work while another is held.
An unavailable receiver can stall later intake for every slice. Restart the
same receiver with its prepared configuration so the producer can replay
from the retained slot. Replanning receiver membership requires coordinated
downtime and a fresh synthetic deployment through this binding. Live tenant
admission, populated slot rebootstrap, and the restore demo require separate
qualification for fixed process rosters.

## Explicit pgstream slot recovery

[Populated pgstream rebootstrap](PGSTREAM-REBOOTSTRAP.md) is an explicit host
operator action after confirmed process exclusion. It replaces only the selected
missing or lost slot, leaves all effect-serving roles stopped and preserves
durable clinical/completed/pending/due/notification state. It never reruns initial
DBA setup or reopens services automatically. Actual populated recovery acceptance
remains UNMEASURED until the recorded platform/database case runs.
