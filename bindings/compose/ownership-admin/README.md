# Ownership-operations overlay

Adds the `admin` role to the imported Compose tree: the private operator service that lists, adds,
transfers and recovers tenant owners. The imported tree in `../multitenant` is not edited.

| file | role |
|---|---|
| `ownership-grants.js` | one-shot step after the imported bootstrap: creates the `<prefix>_ownership_operator` database identity, its six grants, the connection document and the `admin` configuration |
| `admin-entrypoint.js` | starts `nightscout multitenant admin`; the imported `entrypoint.js` names four roles and not this one |
| `compose.ownership-admin.yaml` | Compose override: the `ownership-grants` step (profile `ops`) and the `admin` service |
| `ownership-admin.sh` | runs the imported tree with the override under its own project name |

## What it needs from core

Core must carry the `admin` role (cgm-remote-monitor branch `codex/ownership-role-20261110`,
commits `b726b6a0` and `1376c294`). The tree pinned in `../SOURCE.md` is older (`ed2ced00`) and has no
`admin` role, so this overlay runs only against a core checkout that has it.

Grants are the plan change in core commit `e6f6e248`, ported one for one. The identity has `SELECT`
and `UPDATE(owner_fence)` on `tenant_authorization_config` and `tenant_owner_policy`; `SELECT`, `INSERT`
and `UPDATE(active, can_update, delegable)` on `tenant_owner_actors`; `SELECT` on
`tenant_authorization_subjects`; `INSERT` on `tenant_subject_admin_audit`; and `USAGE` on the
authorization schema only. It has no `DELETE`, no table-level `UPDATE`, no other schema and no
lifecycle control-namespace grant. The imported `config.js` never names the role, so its per-role
control loop never reaches it: the exclusion holds by construction.

If a later import of core's `deploy/multitenant` already carries `e6f6e248`, `ownership-grants.js`
refuses (`IMPORTED_PLAN_ALREADY_HAS_OWNERSHIP_OPERATOR`) and the grants file is retired; the `admin`
service stays.

## The admin service

`ADMIN_HOSTNAME` is the service name `admin` (the container's own address on the private network),
`ADMIN_PORT` is `1342`, and `ADMIN_INSECURE_BIND_ACKNOWLEDGED=true` is set because the listener has no
credential of its own and the address is unreachable from outside: no port is published and no nginx
route points at it. Core's plane rule refuses a wildcard bind and the consumer listener's address.
Core's decision of 2026-11-10 lets admin share the public API's address on a different port; that
core change is not in the commits above, and this overlay moves to it when it lands.

## Running it

```bash
# a core worktree with the admin role and the imported tree in place (see ../README.md)
cd <tree>/deploy/multitenant && ./demo.sh prepare --port 18091 --state /private/state/dir && node build.js
cd bindings/compose/ownership-admin          # in this repository
./ownership-admin.sh <tree> up               # imported bootstrap, ownership-grants, then every role and admin
./ownership-admin.sh <tree> destroy          # down -v; the private state directory stays yours to remove
```

## What is measured

2026-11-10, Compose project `nightscout-multitenant-ownership-admin`, PostgreSQL 16 and Vault by the
digests in the imported `compose.yaml`, core `1376c294` library with the imported `config.js` over it.

| check | result |
|---|---|
| overlay grant statements against core's `grants()` from `e6f6e248`, filtered to the identity | 6 and 6, identical. Control: overlay with the audit `INSERT` dropped gives 5 and 6, `DIFFER` |
| identity attributes | not superuser, no `BYPASSRLS`, `CREATEROLE`, `CREATEDB` or `REPLICATION`; can log in |
| table privileges, from `information_schema` | `tenant_authorization_config` SELECT; `tenant_authorization_subjects` SELECT; `tenant_owner_actors` SELECT, INSERT; `tenant_owner_policy` SELECT; `tenant_subject_admin_audit` INSERT |
| column `UPDATE` privileges | `owner_fence` on config and policy; `active`, `can_update`, `delegable` on actors |
| `USAGE` on schemas; privileges in the control namespace | authorization schema only; 0 control-namespace privileges |
| `admin` service | healthy; `Listening for role admin on <private address>:1342`; `listOwners` for the first synthetic tenant through the contract client: `listed`, 1 owner |
| break-it control: overlay grants with the audit `INSERT` dropped, fresh state | `has_table_privilege(..., audit, 'INSERT')` false; `admin` exits 1, `nightscout multitenant: could not start: preview startup failed`. The role's startup privilege screen refuses; the message is masked by the CLI, so the cause is read from the grant that was dropped |

Not measured: the lifecycle restore demo with the admin role connected (core's census is read-derived to
refuse it while admin is connected; the lane report records that as a decision input). On this base
`tenant-admin` exits 1 with `preview startup failed` with or without the overlay (a plain `demo.sh up`
shows the same), because the imported `config.js` (`ed2ced00`) sits over a core library 61 commits
newer. A re-import of core's current `deploy/multitenant` removes that mismatch.
