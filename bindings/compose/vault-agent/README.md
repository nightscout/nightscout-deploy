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

`up` checks the paired image, starts the stores and private admin, and verifies the platform.
It commissions the AppRole, starts Vault Agent, then starts the selected serving workers.
Use `prime` for tenant provisioning, restore commissioning and synthetic DATA setup.
`demo`, `status`, `stop`, `down` and explicit `destroy` retain their usual meanings;
`destroy` removes only the explicitly owned project's volumes. A private launch
receipt pins source/deployment/project/state/roster/TTL identity before the first
runtime mutation; image build does not commit a runtime TTL selection. Unknown existing
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
`NS_VAULT_AGENT_KEEP_ENV_TOKENS=1` is an explicit static-lab credential-retention control for the no-fallback negative test: it
keeps previous environment credentials while selecting the sink. Registry bootstrap's
previous API token file may remain present, but serving config names only the sink;
its absence or refusal must not fall back to old material.

The machine AppRole secret-id has no expiry and allows reuse; this private login
credential is distinct from its bounded serving tokens. A finite secret-id can
expire before token max TTL and prevent the Agent from logging in again. The
Agent consumes and removes its secret-id input file, retaining it only in memory
for max-TTL reauthentication. Operator revocation and replacement through Vault
remain explicit; no application endpoint gains credential-management authority. After stopping/restarting that Agent, explicitly replace
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
node --test bindings/compose/vault-agent/vault-agent.test.js \
  bindings/compose/vault-agent/tests/plan.test.cjs \
  bindings/compose/vault-agent/tests/guards.test.cjs
```

Vault HTTP responses are explicitly doubled in the unit checks. Pure roster tests
use the committed generators and the immutable evaluator interface from
`962fbdbe8617ed8abe63cad7039fde70f91fcbce`; they do not claim worker runtime scaling.
The historical 2026-11-09 union-policy experiment remains in alignment's immutable
`reports/tenancy/vault-agent-2026-11-09/` and does not establish this registry binding.

Fresh finite native lifecycle capture on 2026-11-12 uses core
`d50502bb6126bda2bb0af384569e1d95de114f2f` paired with deployment
`43cd1e6a85e9b60a5b1b174a840609ce938169f6`. Its real Agent/Vault and two serving
APIs pass auto-auth, renewal, max-TTL reauthentication, missing-sink/expired-token/
seal/transport refusal and recovery, and explicit secret-id replacement. The actual
production parser also accepts the 1/2/4 API environment shapes. A separate real-Agent
expiring-secret control fails reauthentication; nonexpiring restoration passes two
max-TTL cycles. Live four-API capacity and selected realtime/evaluator runtime
scaling are unmeasured here. All owned serving fixtures are stopped and retained.

Exact source/instrument attribution, role receipts, red controls, stopped resources
and limitations live in alignment's
`reports/tenancy/vault-agent-registry-2026-11-12/`. Runtime files in the final delivery
are unchanged from the measured deployment commit above. Default/pilot activation
and comprehensive joined-candidate acceptance remain separate coordinator work.

## Small native operating component proof

Before a complete selected deployment is available, run a finite isolated
Vault/Agent proof with a clean core worktree and a fresh absolute output path:

```bash
node bindings/compose/vault-agent/tests/operating-component.cjs \
  --core /absolute/owned/core \
  --out /mnt/data/nightscout-workspace/artifacts/owned-lane/vault-component-01
```

The command uses the pinned locally available Vault image, creates two owned
containers and one network, publishes only Vault on one explicit loopback port,
and cleans only those exact recorded IDs. The server and Agent are nonroot with
finite CPU/memory limits. The child proof has a 180-second limit. Output and
synthetic private credentials remain in the explicitly selected private output
root; preserve it as sensitive evidence and never commit its `private/` tree.
The server's synthetic data uses retained storage so stop/start can exercise an
actual sealed restart. It is not a backup restoration.

`source.json` pins both Git heads, the image, Agent HCL, production token reader,
Transit client and instrument hashes. `observations.json` retains completed
observations even if a later assertion fails. `proof.json` exists only after
all component assertions pass; `cleanup.json` separately records exact resource
absence. A failed setup is not a semantic refusal control. The instrument refuses
an existing output directory and never adopts a prepared deployment or its
credentials. Keep all original failed captures.

The probe uses actual CA verification, AppRole login, renewal/max-TTL re-login,
production HMAC/decrypt operations, missing sink, expiry/revocation, seal/unseal,
transport outage and recovery. It also verifies that the serving policy cannot
read or manage keys. These are native **component** observations. API serving,
external identity, actual client binaries, selected-image recovery timing,
production unseal custody, populated backup restoration and capacity need their
own selected-deployment evidence. See the
[dependency recovery runbook](../../../operator/runbooks/host-and-dependency-replacement.md#credential-and-vault-recovery-on-a-selected-streaming-deployment).
