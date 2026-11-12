# Single-host multitenant Compose demonstration

This explicit synthetic deployment runs API, realtime, evaluator, tenant-admin
and the shipped web pages in separate containers. nginx presents one browser
origin. PostgreSQL and TLS-enabled Vault stay on the private network. It does
not change `nightscout single` or the existing Mongo Compose deployment.

The deployment uses synthetic tenants and generated private credentials. Keep
real records and identities out of this demonstration. Executed sources and
acceptance belong to the [alignment release record](https://github.com/bewest/rag-nightscout-ecosystem-alignment/blob/main/releases/cgm-remote-monitor-16.0.0/contents.md);
source checks do not establish restore acceptance.

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

`bootstrap` is a deliberate one-shot operation, not an application startup hook.
It prepares the schema, grants and synthetic tenant configuration before roles
can pass their own read-only admission checks. `up` repeats the bootstrap entry
point for its supported restart/unseal handling; it must refuse partial setup
instead of adopting unknown existing schemas.

Start order: `up` runs the bootstrap first, then Compose starts the roles in
dependency order, each waiting for the previous one's healthcheck: PostgreSQL
and Vault, then api, then realtime and tenant-admin, then evaluator. nginx waits
only for the services it routes to (api, realtime, ui), so an unhealthy evaluator
or tenant-admin does not keep the site down. The Compose edge mounts
`nginx.compose.conf`: `nginx.conf` (which the Kubernetes binding imports) plus
re-resolution of the upstream names through Docker's DNS (10 s validity), so a
role container restarted on its own is reached again without an edge restart.
`check-compose.js` holds the two files equal apart from those lines.

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

The tenant count (`NS_DEMO_TENANTS`) is bounded by core's preview tenant ceiling
(`lib/server/serve/tenant-ceiling.js`, 10,000), which the ui also enforces; the
bootstrap runs the ui's own parser on the ui configuration it writes. Realtime
admits at most `NS_DEMO_TENANTS` x `NS_DEMO_SOCKETS_PER_TENANT` sockets (1..100,
default 2; never below 100), across all tenants and Socket.IO namespaces. It is
part of the realtime configuration, so a change needs a fresh bootstrap and a
realtime restart. With a core that predates `tenant-ceiling.js` or
`config-file.js`, `ui.js` and `config.js` keep their former bounds and say so on
stderr.

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

## Credentials and initialization

Each runtime service mounts only its own generated read-only configuration
directory. The UI and nginx receive no database credentials. Only the one-shot
bootstrap mounts the full private output directory and initial database/Vault
material. The separate operator demonstration mounts only its operational
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
not renew them.

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
Its login/callback/session integration is not implemented by this Compose file.
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

Generated edge and replica files live in private deployment state. Their input
policy changes take effect through explicit preparation rather than mutating running
role authority or silently changing the fixed maintenance census.
