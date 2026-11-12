# Source of `multitenant/`

| field | value |
|---|---|
| upstream repository | nightscout/cgm-remote-monitor |
| upstream path | `deploy/multitenant` |
| upstream commit | `65ea9e37cb93e7e8e50f512cb3a6bc4709435011` (local M7 integration source; final acceptance pending) |
| upstream tree hash of that path | `37730434b08d5e9b54d56c9455aecc62ff001be7` (core's reduced fixture: `config.js`, `demo.js`, `health.js`, `restore.js`, `ui.js`, `README.md`) |
| import method | Recorded core fixture plus reviewed deployment-owned bootstrap, placement, edge and preparation changes; the patch is checked by `tools/compose-identity-check.sh`. |
| local delta | [`SOURCE.delta.patch`](SOURCE.delta.patch), against the recorded core fixture. This binding generates fixed API instances and exact maintenance addresses, supports local health probes for network listeners, removes realtime maxSockets and renders explicit per-IP edge budgets. The reduced core fixture stays test-only. |
| tree hash here | `90368d78ac58d0d1c0c66b22cc8087608a55845f` |
| imported on | 2026-11-11 |

History: first imported 2026-11-09 from `ed2ced00c80bd0a6a7d75f834d2c6e2af8c71364` (tree
`8be3d761cbe592428357d6cee29612affafe4122`) by `git subtree`, which keeps the per-file history; the
2026-11-10 copy brings in the 13 core commits (merges included) that touched the path since then.

From core commit `16a1fc2d` onward this repository is the home of the Compose tree. Core keeps a
reduced `deploy/multitenant` with only the modules its own tests load (`config.js`, `demo.js`,
`health.js`, `restore.js`, `ui.js`). `tools/compose-identity-check.sh <core>` compares exactly those
files: core's copy at the recorded commit with the delta applied must equal the copy here, byte for
byte (core's `README.md` is not compared). Every other file here (`bootstrap.js`, `compose.yaml`, the
Dockerfile, `prepare.js`, ...) has no upstream copy and is checked only against the tree hash above.
Changes core makes to those files on a lane branch reach this tree by hand, as listed in the import
method.

2026-11-11 sync to `0392acf9` (alignment `reports/tenancy/batch-join-2026-11-11/0392acf9-acceptance/README.md`,
"What nightscout-deploy needs to match this head"):

- `config.js`: the `change_stamps` catalogue; `require('../../lib/change-stamps/postgres').grants(...)` at
  the end of `grants()` with realtime and evaluator as roles and checkers (USAGE, SELECT on the
  function's `schema_migrations`, EXECUTE); the api gets `SELECT,UPDATE(last_stamp,last_delete_stamp)` on
  `tenant_write_clock`; realtime and evaluator name `changeStamps`; realtime takes
  `authorizationRecheckMs: 30000`; `lifecycle()` excludes `change_stamps` as it excludes `control`.
  Bench fix 1 (`root_writer` window reads) is in core's plan now and leaves the delta.
- `bootstrap.js`: the function-ownership loop accepts the reviewed signature `tenant_change_stamps(uuid[])`
  and refuses any other argument list. The function owner owns every catalogue schema, the clock schema
  included, which is the USAGE the definer function needs.
- `compose.yaml`: api, realtime and evaluator healthchecks get `start_period: 900s`, `start_interval: 2s`.

The delta keeps the ownership identity overlay-shaped: core's plan creates and grants it in
`layout()` and `grants()`; here the base plan does not, and `ownership-admin/ownership-grants.js`
creates it after bootstrap with the same statements. Base `grants()` plus the overlay's statements
equal core's `grants()` at the recorded commit (the overlay README has the measurement).

The tree references core by relative path (`../../lib/...`) and the Dockerfile builds from the core
checkout, so it runs only overlaid on a core checkout at this commit; `tools/compose-overlay.sh` does
that. When this copy or the delta changes, update this file, the delta and the recorded hashes in the same
commit; `tools/compose-identity-check.sh <core>` checks all three.

## Bench fixes (branch `bench/compose-baseline-20261110`)

Found bringing the tree up with real role processes for MT-BENCH-BASELINE (alignment
`reports/tenancy/bench-baseline-2026-11-10/`).

1. **api refuses startup: `root_writer` has no control-schema reads.** At core `16a1fc2d` the api
   exits 78 (`preview readiness or storage initialization refused`). Cause, from a temporary
   diagnostic: `SUBJECT_ADMIN_STORE_UNSAFE` wrapping `LIFECYCLE_WINDOW_SCHEMA_UNSAFE`; the subject-admin
   store opens its `root_writer` connection under the tenant operation window
   (`lib/subject-admin/postgres.js:48`, `lib/storage/postgres-connection.js:128`,
   `lib/tenant-lifecycle/operation-window.js:57`), and window admission requires USAGE on the control
   schema and SELECT on `schema_migrations`, `tenant_lifecycle_windows`, `tenant_lifecycle_operations`
   (`lib/tenant-lifecycle/operation-window-readiness.js:44`), which `grants()` withholds from
   `root_writer`. Fix: `root_writer` joins the loop that grants those reads to every other serving
   identity. Reproduced red without the fix (unmodified core plan), green with it. Owner decision
   still open: whether `root_writer` should be fenced by the window (this fix) or its store should not
   use the window.
2. **The plan is fixed at two tenants.** `documents()` and `bootstrap()` enumerate `[A, B]`, aliases,
   Vault keys/tokens, locks and `maxTenants: 2`, so the one-host reference cannot be measured at 1, 10,
   50 or 200 tenants. Fix: `NS_DEMO_TENANTS` (1..1000 at first, 1..10000 since the 2026-11-11 sync; default 2) on the bootstrap service; tenants 0
   and 1 keep the A/B ids and aliases, later tenants get fixed synthetic UUIDs and `t<i>.example.test`;
   per-tenant Vault keys, scoped tokens (`NS_VAULT_<i>`), lifecycle locks (`810001+i`) and
   `maxTenants: N`. Measured: `documents()` at the default is byte-identical to core's (15357 bytes);
   at 200 it yields 200 tenants, locks, Vault references and unique ids; `bootstrap.test.js` passes
   5/5 at the default. The restore demonstration (`restore.js`) still requires exactly two tenants,
   and `ownership-admin/ownership-grants.js` still lists A and B only.

## Capacity fixes (branch `deploy/capacity-fixes-20261111`)

Found by the 2026-11-11 capacity campaign (alignment `tools/mt-bench/capacity/`); evidence in alignment
`reports/tenancy/deploy-capacity-fixes-2026-11-11/README.md`. None touches core's fixture files, so
the delta is unchanged.

1. **Bootstrap failure detail.** An error without a code printed only `COMPOSE_BOOTSTRAP_FAILED`;
   the stderr line now adds the redacted `detail` and the top stack frames (`at`).
2. **Compact role documents.** Role configuration, environment, operation, admission and UI files
   are compact JSON (35.5% smaller at 1,000 to 5,000 synthetic tenants, measured offline); with
   core's 1 MiB cap the api `config.json` limit moves from under 2,000 to between 2,500 and 2,600
   tenants. `NS_BOOTSTRAP_CONFIG_MAX_BYTES` (off by default) reaches the role containers through the
   Compose environment as `MULTITENANT_CONFIG_MAX_BYTES` (core lane `workspace/capacity-fixes-20261111`
   `5517cb6c`, `lib/server/serve/config-file.js`), and `load-env.js` takes its `env.json` bound from
   that reader (fixed 1 MiB with a core that lacks it, such as the recorded commit).
3. **Edge after a role restart.** `nginx.compose.conf` = `nginx.conf` plus re-resolution through
   Docker's DNS; `nginx.conf` stays resolver-free for the Kubernetes binding.
4. **Start order.** `depends_on: service_healthy` from postgres and vault through the roles; nginx waits
   for api, realtime and ui only.
5. **Overlay build.** `tools/compose-overlay.sh` writes `.overlay.json`; `prepare.js`/`build.js`
   check and build core HEAD plus the deploy commit instead of refusing every overlay as
   `BUILD_INPUTS_DIRTY`.
6. **ui tenant ceiling, realtime sockets, ui validation at bootstrap** (core lane `5c60aec6`). `ui.js`
   refused more than 1,000 tenants; it is now core `5c60aec6`'s, plus the fallback above.
   `tenantCount` takes its bound from core's `PREVIEW_MAX_TENANTS`. Realtime `maxSockets` =
   tenants x `NS_DEMO_SOCKETS_PER_TENANT` (1..100, default 2), never below the former 100, so the
   default demonstration's documents are unchanged. `validateFiles` runs the ui's `parseConfig` on
   the written ui config.
