# Vault Agent sidecar overlay

*Contributor- and operator-facing. State: overlay written 2026-11-09; see "What is measured"
for what has run. The imported tree in `../multitenant` is not edited by this overlay.*

Decision of record: cgm-remote-monitor release record
`releases/cgm-remote-monitor-16.0.0/decisions.md`, anchor `vault-agent-sidecar` (alignment
workspace, 2026-11-09). Vault connectivity uses Vault Agent as a sidecar. Auto-auth, the token
sink file and renewal belong to the Agent; the application reads the token from the sink at call
time and keeps its small Transit client. No hand-rolled login or renewal in core.

## What this overlay adds

| file | role |
|---|---|
| `compose.vault-agent.yaml` | Compose override: a `vault-agent` service (same `hashicorp/vault` digest as the imported `compose.yaml`), a one-shot `vault-agent-bootstrap` step, and one read-only sink mount (`/run/ns-vault`) on `api`, `realtime`, `evaluator` and `tenant-admin` |
| `agent.hcl` | Agent configuration: `auto_auth` method `approle` reading `role_id` and `secret_id` files with `remove_secret_id_file_after_reading`, one `file` sink at `/run/ns-vault/token` (mode 0600), TLS through the demo CA exactly as the imported tree does, no listener/cache/template |
| `vault-agent-bootstrap.js` | The step after the imported `bootstrap.js`: enables AppRole, writes one Transit policy, creates the role, writes `role_id` and `secret_id` (0600) into the private state, and points the `api` document at the sink |
| `vault-agent.sh` | Runs the imported tree with the override under its own project name and env file |

Core side: `lib/server/serve/preview-config.js` accepts `tokenFile` as the alternative to
`tokenEnv` in each tenant's `vault` block (exactly one of the two; a relative or empty path
refuses at load). The sink is read with `fs.promises.readFile` on every Transit call and trimmed,
so a token the Agent renews or re-issues is used by the next operation without a restart. A
missing, unreadable or empty sink fails that operation closed with `SECRETS_PROVIDER_UNAVAILABLE`
and never falls back to an environment token. The Transit client is unchanged. Queue item
`MT-VAULT-TOKEN-FILE`; branch `codex/vault-token-file-20261109` on top of `ed2ced00`.

## Running it

```bash
# 1. a core worktree carrying tokenFile, with the imported tree in place
#    (tools/compose-overlay.sh pins the recorded commit; for a branch head run its two steps:
#    git worktree add --detach <tree> <head>; cp -a bindings/compose/multitenant <tree>/deploy/multitenant)
cd <tree>/deploy/multitenant && ./demo.sh prepare --port 18090 --state /private/state/dir
echo NS_DEMO_IMAGE=nightscout-multitenant-vault-agent:local >> .env     # keep a plain demo's tag intact
node build.js

# 2. from this directory
NS_VAULT_AGENT_TOKEN_TTL=1h NS_VAULT_AGENT_TOKEN_MAX_TTL=24h ./vault-agent.sh <tree> up
./vault-agent.sh <tree> demo
./vault-agent.sh <tree> destroy        # down -v; the private state directory stays yours to remove
```

`up` runs the imported bootstrap (unchanged), then `vault-agent-bootstrap`, then starts the Agent
and waits for its sink before `api` starts (`depends_on: vault-agent: service_healthy`). The
step is idempotent through `/state/vault-agent/complete.json`; a restarted Agent needs a fresh
`secret_id` (`./vault-agent.sh <tree> secret-id`, then `agent start`) because the Agent removes
the file after reading it and keeps the value only in memory.

Environment accepted by the step: `NS_VAULT_AGENT_TOKEN_TTL` (default `1h`),
`NS_VAULT_AGENT_TOKEN_MAX_TTL` (default `24h`), `NS_VAULT_AGENT_KEEP_ENV_TOKENS=1` (control runs
only: leaves the imported per-tenant environment tokens in `api/env.json` so that a fallback,
if one existed, would be visible). Durations are `<n>s|m|h`.

## Credentials, by location only

| credential | where | who reads it |
|---|---|---|
| Vault root and unseal material | `/state/bootstrap/vault-init.json` (imported bootstrap, 0600) | imported `bootstrap`, `vault-agent-bootstrap` |
| AppRole `role_id` | `/state/vault-agent/creds/role_id` (0600) | `vault-agent` only |
| AppRole `secret_id` | `/state/vault-agent/creds/secret_id` (0600); removed by the Agent after the first read | `vault-agent` only |
| Agent token | `/state/vault-agent/sink/token` (0600), mounted read-only at `/run/ns-vault/token` | `api` (per Transit call); mounted into `realtime`, `evaluator`, `tenant-admin` for the roles that gain Vault calls later |
| imported per-tenant tokens (`NS_VAULT_0`, `NS_VAULT_1`) | dropped from `/state/api/env.json` by the step unless `NS_VAULT_AGENT_KEEP_ENV_TOKENS=1` | nobody, once `tokenFile` is in force |

The Agent runs as the runtime uid (`NS_RUNTIME_UID`, default 1000), the uid that owns the
private state, so no file is widened beyond 0600 and no root chown happens in the container.

## Design point for the maintainer (not decided here)

The imported bootstrap mints **one token per tenant with a per-tenant policy**
(`<prefix>_tenant_0`, `<prefix>_tenant_1`): tenant 0's token cannot call tenant 1's keys at
Vault. One Agent has one login, so this overlay creates **one AppRole whose policy is the union
of the imported per-tenant policies**, read from Vault at provisioning time. Every serving
process then holds a token that can reach every tenant's Transit keys on the mount.

Trade-off, stated plainly:

- **What moves.** Tenant separation at Vault (which token may touch which key) moves to the
  application's authority layer and PostgreSQL RLS: the API picks the tenant's key from the
  tenant's config after the request is bound to a tenant. A bug that confuses tenants in the
  application can now reach another tenant's key where before Vault would have refused.
- **What is gained.** No hand-rolled login or renewal in core; tokens renew and rotate without
  restarts; one credential to custody per host instead of one per tenant; the same shape as the
  Kubernetes native sidecar.
- **Alternatives that keep per-tenant separation at Vault.** One Agent per tenant with one sink
  per tenant (`tokenFile` already allows one path per tenant, so core needs no change); or one
  Agent with `auto_auth` into several sinks is not a Vault Agent feature, so the per-tenant option
  costs one container per tenant. Vault Enterprise namespaces are out of scope for this binding.

This README states the mechanism; the decision belongs in the release record.

## What is measured

Record at the time of writing, 2026-11-09; the alignment report
`reports/tenancy/vault-agent-2026-11-09/README.md` carries the figures from output.

| check | state |
|---|---|
| `tokenFile` unit tests (core): rewritten sink picked up by the next call; both/neither refuse at load; unreadable or empty sink fails closed with the env token set and unused | measured, 5 passing; two ablations go red (cached-at-load, env fallback) |
| `tools/compose-identity-check.sh`: imported tree untouched by this overlay | measured, see the report |
| Compose smoke with the overlay, short TTL: Transit call succeeds after the TTL has passed (renewal) | see the report |
| Control: Agent stopped, TTL passed, next Transit call fails closed with env tokens present; `secret-id` + `agent start` recovers | see the report |

A check that has never gone red is not evidence; the controls above are the red half.
