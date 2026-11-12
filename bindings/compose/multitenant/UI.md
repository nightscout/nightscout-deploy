# Browser UI and public ingress

This presentation process renders the repository's actual EJS dashboard, food editor,
profile editor and reports pages. It serves the production webpack artifacts,
startup scripts, static assets, translations and service worker from the same
application image as the API. It imports no test fixture and starts no clinical
server or credential verifier. Registry mode opens only a dedicated metadata resolver
pool; it has no clinical, settings or secret read capability.

Run `node deploy/multitenant/ui.js` with:

- `UI_PUBLIC_CONFIG=/run/ns-config/config.json`: a read-only **public-only** file.
- `UI_HOSTNAME=0.0.0.0`, `UI_PORT=1340`: container-private TCP listener.

The static lab projection retains this shape:

```json
{"version":1,"tenants":[{"aliases":["one.example.test"],"theme":"default"},{"aliases":["two.example.test"],"theme":"modern"}]}
```

Aliases contain no port and must be unique. The only permitted theme values are
`default` and `modern`. Unknown fields, including secrets and connection strings,
refuse startup. An unrecognized Host receives HTTP 421. The projection selects
only the server-rendered HTML theme; restart the UI after changing it. Current
tenant settings, identity and clinical records still come through the existing
API/realtime protocol and its current-authority checks. Static mode mounts no credentials. Registry mode mounts only its dedicated registry
connection environment, never tenant credentials; neither mode embeds credentials
in rendered pages. The existing browser
credential/token interface remains available; this process adds no OIDC routes.

Registry deployments use this exact version-2 shape instead of an alias list:

```json
{"version":2,"registry":{"connectionEnv":"NS_UI_REGISTRY_PG","namespace":"cohort_registry","maxTenants":10000,"refreshMs":2000,"maxInflight":32},"theme":"default"}
```

`connectionEnv` names an environment value; no connection string, provider/module
path or static roster belongs in this public configuration. Load the UI's own
private environment with `node -r ./deploy/multitenant/load-env.js
./deploy/multitenant/ui.js`. The dedicated LOGIN/NOSUPERUSER/NOBYPASSRLS/
NOREPLICATION identity receives only product `tenant-registry/postgres.grants`
`resolvers` capability (lookup and revision), without `readers`, enumerators,
control, data, secret or settings grants. Startup refuses memberships, elevated
role attributes, table/column data access, sequence grants and additional user
SECURITY DEFINER execution. Product registry catalogue admission pins the exact
lookup/revision implementations and their owners before resolution.

Positive aliases and unknown aliases use the product resolver's bounded caches;
revision observation invalidates both without restarting UI. Defaults are 10,000
positive entries, at most 1,024 negative entries, a 2-second revision poll, two SQL
clients and at most 32 in-flight resolutions (configurable 1–256). Resolution beyond
the in-flight bound returns HTTP 503. Invalid, unknown, private/internal and
untrusted forwarded selectors return HTTP 421. Resolver/database refusals return
503 without error details. The theme remains a single explicit presentation
choice; current settings and authority still come from API/realtime. SIGTERM stops
HTTP admission and closes the component-owned resolver and database pool.

Focused controls:

```bash
NS_UI_TEST_CORE=/absolute/path/to/pinned/core node bindings/compose/multitenant/ui-registry.test.js
NS_UI_REGISTRY_NATIVE_TEST=1 NS_UI_TEST_CORE=/absolute/path/to/pinned/core node --test bindings/compose/multitenant/ui-registry.integration.test.js
```

The native control owns one PostgreSQL container, uses synthetic registry rows,
actual core resolver/catalogue/template/asset factories, and verifies a real UI
child closes its database sessions on SIGTERM. It does not execute full provisioning,
restore census, browser acceptance or capacity; those remain joined deployment gates.

The enabled page routes are `/`, `/food`, `/profile` and `/report`. Serving their
real HTML does not broaden the API's admitted operations. `/admin`, split frames,
clock pages and tenant-management pages are outside this initial UI mount.

Startup requires all production app, clock, food, profile and reports bundles.
Missing artifacts fail startup. Build the image from the same source checkout;
do not reuse a peer worktree's bundle cache.

## nginx

The supplied configuration listens on container port 8080. Compose publishes only
that port, on loopback by default or an explicitly configured existing private
host interface such as `169.254.1.1`. It does not create host interfaces.

- `/api` and `/api/…` go to `api:1337`.
- `/socket.io/…`, including polling, browser client download and WebSocket
  upgrades for all Socket.IO namespaces, go to `realtime:1339`.
- Page and asset requests go to `ui:1340`.

The public Host is preserved for **direct-alias** tenant resolution. Supplied
forwarded/internal-selector headers are stripped; this configuration does not
establish canonical-ingress trust. Authorization/api-secret headers reach the
API/realtime handlers; those headers and cookies are stripped from UI upstream
requests. Existing browser navigation links may carry a legacy query token to
the UI listener: the page does not reflect it and request logging is disabled.
The unchanged browser reads its own navigation URL and authenticates subsequent
API/socket operations. Public management/operator paths are not
proxied to tenant-admin or the restore controller. Keep those components on
private listeners/networks and mount private Unix sockets only in their actual
participants.

`/healthz` is a private UI container probe and is blocked at nginx. Its success
means the public projection and production bundles loaded, not that API,
realtime, database or tenant restore is healthy. The reference HTTP ingress is
for local synthetic demonstration; production certificate and trusted-edge
configuration retain their own acceptance.

## Focused verification

After installing this checkout's locked dependencies and building its production
bundle, run:

```bash
node node_modules/mocha/bin/mocha.js --fail-zero --timeout 5000 tests/compose-ui.test.js
```

The suite renders actual shipped pages and exercises real Express routing without
opening a listener. Native nginx, browser, Socket.IO and cross-process restore
acceptance belong to the joined deployment run; source tests do not establish
those results.
