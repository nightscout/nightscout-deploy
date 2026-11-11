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

The core commit pinned in `../SOURCE.md` (`16a1fc2d`) carries the `admin` role. Core's own plan at
that commit names `ownership_operator` in `layout()` and grants it in `grants()`; this repository's
`../multitenant/config.js` leaves both out (the recorded delta, `../SOURCE.delta.patch`), so the
identity and its grants come only from this overlay.

The grants are core's, statement for statement. The identity has `SELECT` and `UPDATE(owner_fence)` on
`tenant_authorization_config` and `tenant_owner_policy`; `SELECT`, `INSERT` and
`UPDATE(active, can_update, delegable)` on `tenant_owner_actors`; `SELECT` on
`tenant_authorization_subjects`; `INSERT` on `tenant_subject_admin_audit`; `USAGE` on the
authorization schema; and, in the lifecycle control namespace, `USAGE` and `SELECT` on the three
tenant-phase tables (`lib/tenant-lifecycle/tenant-phase.js` `phaseGrants`), which core added after
`e6f6e248`. It has no `DELETE`, no table-level `UPDATE`, no clinical table, and no operation, window or
ceremony write. The base plan's per-role control-namespace loop never reaches it, because the base
`layout()` does not name it.

If the base plan ever names the role again, `ownership-grants.js` refuses
(`IMPORTED_PLAN_ALREADY_HAS_OWNERSHIP_OPERATOR`).

## The admin service

`ADMIN_HOSTNAME` is the service name `admin` (the container's own address on the private network),
`ADMIN_PORT` is `1342`, and `ADMIN_INSECURE_BIND_ACKNOWLEDGED=true` is set because the listener has no
credential of its own and the address is unreachable from outside: no port is published and no nginx
route points at it. Core's plane rule refuses a wildcard bind and the consumer listener's address.
Core's decision of 2026-11-10 lets admin share the public API's address on a different port; this
overlay keeps its own service address.

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

### 2026-11-10, after the sync to core `16a1fc2d`

Source-level, no Compose run. Base plan from this repository, overlay from this directory, core plan
from `16a1fc2d:deploy/multitenant/config.js`, all loaded against core `16a1fc2d`'s library.

| check | result |
|---|---|
| overlay statements against core's `grants()` filtered to the identity | 10 and 10, identical |
| base `grants()` plus overlay statements against core's `grants()` | 345 and 345, identical |
| roles in core's `layout()` absent from the base `layout()` | `ownership_operator` only (16 and 15) |
| base `documents()` against core's `documents()`, same synthetic inputs | identical |
| `node --test bootstrap.test.js restore.test.js` in the overlaid tree | 10 tests, 10 pass |
| break-it control: the `phaseGrants` line removed from `ownership-grants.js` | 10 and 6, `DIFFER`; 345 and 341, `DIFFER`. Restored: identical. The overlay as first committed (six statements) is that broken state against `16a1fc2d` |

Not measured on this base: the Compose run of the overlay (`ownership-admin.sh <tree> up`) and the
restore demonstration with `admin` connected.

### 2026-11-10, `admin.json` and core's admin configuration

`admin.json` now carries `ownership.lifecycleNamespace` (the lifecycle control namespace). Core at
`16a1fc2d` requires it and requires it to differ from `namespace`
(`lib/server/serve/admin-config.js:59-60`); without it the `admin` role exits with "invalid explicit
admin operator configuration". Found on the Kubernetes binding's kind smoke, where the role exited
exactly so. `ownership-grants.test.js` checks the document's keys against that list and, with
`NS_CORE_DIR` pointing at a core checkout at the recorded commit, runs core's own parser on it.

| check | result |
|---|---|
| `NS_CORE_DIR=<core 16a1fc2d> node --test ownership-grants.test.js` | 2 tests, 2 pass |
| break-it: `lifecycleNamespace` removed from `adminDocument` | 2 fail; core's parser throws `invalid explicit admin operator configuration`. Restored: 2 pass |
| without `NS_CORE_DIR` | 1 pass, 1 skipped |
