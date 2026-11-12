# Opt-in Vault Agent for the Compose binding

This overlay selects one Vault Agent and one AppRole per deployment. It supports
registry mode and the explicit fixed API roster (`api`, `api-2`, …), while preserving
the base binding when the overlay is not selected. Decisions of record are the
alignment release decisions `vault-agent-sidecar` and `vault-one-approle-per-deployment`.

The Agent owns AppRole login, renewal and max-TTL reauthentication. Serving APIs
read its token sink on every Transit call. The policy has six fixed rules: decrypt
`tenant-data-*`, HMAC/verify `tenant-signing-*`, sign `tenant-access-*`, and token
self-lookup/renewal. Static lab key naming uses the corresponding fixed suffix
patterns. It never imports or unions tenant policies, enumerates keys or leases,
or grants key management or management-session signing. Provisioning and management
issuer credentials remain on their existing private operator paths.

Only selected APIs receive the read-only sink mount. Realtime, evaluator, UI,
placement publisher and operation helpers inherit no Agent credential. Agent
credentials are mounted only into the Agent; the private provisioning helper
retains the imported bootstrap's operator custody, outside serving containers.

## Commands

Prepare an explicitly pinned core/deployment overlay using the companion's normal
source-identity tooling. Select replicas and worker rosters during preparation;
subsequent shell overrides cannot retarget the prepared roster. Choose a fresh,
private state directory and a unique explicit Compose project:

```bash
NS_API_REPLICAS=2 node <core-tree>/deploy/multitenant/prepare.js \
  --port 18090 --state /private/agent-state
NS_VAULT_AGENT_PROJECT=synthetic-agent \
  ./vault-agent.sh <core-tree> plan
NS_VAULT_AGENT_PROJECT=synthetic-agent \
  ./vault-agent.sh <core-tree> config
NS_VAULT_AGENT_PROJECT=synthetic-agent \
  ./vault-agent.sh <core-tree> build
NS_VAULT_AGENT_PROJECT=synthetic-agent \
  ./vault-agent.sh <core-tree> up
```

`plan` and `config` write no authoritative state. Generated API sink overrides go
through Compose stdin. Selected API, realtime and evaluator generated overlays
must match their committed generators exactly. An explicitly selected evaluator
roster requires the binding's `evaluator-workers.js` and `compose.evaluator.yaml`;
older bindings refuse that selection instead of silently running one worker.

`up` checks the paired image, starts infrastructure, bootstraps private operator
state, starts admin/feed, provisions through the admin API, commissions restore,
provisions the AppRole, starts Agent, then starts every API. It primes through DATA
APIs, publishes the private primer handoff, and starts the selected realtime/
evaluator workers, owner role, UI and edge. It writes no SQL settings seed.

`bootstrap` performs infrastructure and private bootstrap/Agent provisioning only.
`demo`, `status`, `stop`, `down` and explicit `destroy` retain their usual meanings;
`destroy` removes only the explicitly owned project's volumes. A private launch
receipt pins source/deployment/project/state/roster/TTL identity. Unknown existing
projects cannot be adopted for mutation; changed identities refuse. Image and
working-directory labels are checked before operating on existing containers.

The application image contains the exact source/deployment pair. The Agent/server
use the pinned Vault image digest declared in the overlay; they are distinct
services and resources. The host launcher/bootstrap overlay must match the recorded
deployment commit. `NS_DEMO_IMAGE`, if customized, belongs in the prepared private
`.env` so the image check and all commands select the same image.

## Token lifecycle and state custody

`NS_VAULT_AGENT_TOKEN_TTL` defaults to `1h`; `NS_VAULT_AGENT_TOKEN_MAX_TTL` defaults
to `24h`. Both accept positive seconds/minutes/hours, with TTL no greater than max
TTL and max TTL bounded to 32 days. Keep the same values on repeat commands.
`NS_VAULT_AGENT_KEEP_ENV_TOKENS=1` is an explicit static-lab fallback control: it
keeps previous environment credentials while selecting the sink. Registry bootstrap's
previous API token file may remain present, but serving config names only the sink;
its absence or refusal must not fall back to old material.

The Agent consumes and removes its secret-id file, retaining it in memory for
max-TTL reauthentication. After stopping/restarting that Agent, explicitly replace
its secret-id before starting it:

```bash
NS_VAULT_AGENT_PROJECT=synthetic-agent ./vault-agent.sh <core-tree> agent stop
NS_VAULT_AGENT_PROJECT=synthetic-agent ./vault-agent.sh <core-tree> secret-id
NS_VAULT_AGENT_PROJECT=synthetic-agent ./vault-agent.sh <core-tree> agent start
```

All credential files are private and identified by location, never value:

| material | private location | reader |
|---|---|---|
| imported Vault root/unseal material | state/bootstrap/vault-init.json | private bootstrap helpers |
| AppRole role-id and secret-id | state/vault-agent/creds/ | Agent only |
| Agent token | state/vault-agent/sink/token | Agent writes; exact APIs read-only |
| provisioning/management credentials | existing state/admin/ files | existing private admin authority |

Preflight checks real private directories/files without symlink traversal, bounded
bytes, exact source identity and every API config/environment/operation file. The
shipping core parser validates candidate API configs in a private temporary scratch
directory, which is removed; credentials remain in memory. No authority/Vault
mutation starts before this succeeds. Repeat provisioning compares exact digests
and returns locally without creating another role or token. The receipt intentionally
permits Agent-owned sink rotation and secret-id consumption, while checking their
private custody when present.

A journal precedes provisioning and secret-id effects. A partial or mutated state
refuses further provisioning; it is never silently repaired or declared complete.
Keep its private evidence, stop its owned services, and prepare a fresh private
state/project for recovery. Do not remove peer resources. Agent health means a
nonempty sink exists; actual authorization, expiry and Vault outage are determined
by serving Transit calls, not by that file-existence healthcheck.

## Verification scope

Focused checks exercise registry 1/2/4 APIs, constant policy/request cost, private
custody, mixed/changed state and repeated identity refusal. Run:

```bash
node --test bindings/compose/vault-agent/vault-agent.test.js
```

Vault HTTP responses are explicitly doubled in these unit checks; they do not
measure Agent login/renewal or fresh serving-image behavior. The historical
2026-11-09 union-policy experiment is recorded only in alignment's immutable
`reports/tenancy/vault-agent-2026-11-09/`; it does not establish this registry
capability. Fresh Agent/Vault/API lifecycle evidence and controls are required
before declaring the conversion verified. No default or capacity-pilot activation
is part of this overlay change.
