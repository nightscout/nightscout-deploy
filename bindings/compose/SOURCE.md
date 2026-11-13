# Source of `multitenant/`

| field | value |
|---|---|
| upstream repository | nightscout/cgm-remote-monitor |
| upstream path | `deploy/multitenant` |
| upstream commit | `d0036890d0623ae79f14bfa71e7226c0fa122a29` (opt-in constructor/cold-start admission with preserved credential option semantics, repaired background context, authenticated peer-close quiescence and retained uncertainty; runtime and qualification of this new pair are UNMEASURED) |
| upstream tree hash of that path | `fdc9f8dd2644b8789c86abeb030fbc0ad7304780` (core's reduced fixture: `config.js`, `demo.js`, `health.js`, `restore.js`, `ui.js`, `README.md`) |
| import method | Recorded core fixture plus reviewed deployment-owned bootstrap, placement, edge and preparation changes; the patch is checked by `tools/compose-identity-check.sh`. |
| local delta | [`SOURCE.delta.patch`](SOURCE.delta.patch), against the recorded core fixture. This binding generates fixed API instances and exact maintenance addresses, supports local health probes for network listeners, removes realtime maxSockets and renders explicit per-IP edge budgets. The reduced core fixture stays test-only. Selected connection-budget support adds explicit source-derived PostgreSQL sizing, finite worker/observer credits, private one-use tickets and actual-close quiescence; default behavior remains unchanged. See [`multitenant/CONNECTION-BUDGET.md`](multitenant/CONNECTION-BUDGET.md). |
| tree hash here | `1738a3e6a0854e55243c29bc5b4dbf3b3c523b71` |
| imported on | 2026-11-12 |

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

2026-11-12 controlled-placement binding: the optional fixed realtime roster uses
durable registry Host resolution, stable logical shards, separate backend/route
views and private controlled publication. The default remains unsharded. Explicit
M7 diagnostics settings are recorded in preparation, off by default. Focused product
parser/client/driver checks pass; actual full-stack move/recovery and the frozen
comprehensive campaign remain separate acceptance boundaries.

Realtime registry admission repair: the serving role holds the narrow resolver and
enumerator capabilities, without raw registry/key table reads. The strict source
readiness guard remains unchanged. Selected placement launchers include every fixed
worker and the socket edge. Default-topology fresh-image diagnostics and controlled
move/recovery acceptance retain their separate evidence scopes.

## Current joined binding boundary — 2026-11-12

The refreshed delta records already joined deployment-owned behavior: optional fixed
evaluator workers and their narrow pool metadata roles; separate listen-only feed
and placement-publisher custody; registry-based common maintenance coverage; and
bounded retries only for known read/exchange warming. It preserves the source's
DATA write behavior and strict independent SQL actor census. Native proof fixtures
use explicit owned projects with bounded unique suffixes; they do not add a
shipping configuration-authority bootstrap API.

The reduced upstream fixture tree is unchanged; its reviewed deployment delta and
the complete committed binding tree are now pinned together. The optional Vault
Agent overlay lives beside this tree and keeps its separate exact-source lifecycle
evidence. This metadata refresh enables paired-image qualification; it does not
claim comprehensive, paired deployment or capacity acceptance. Additional component
profile/runtime wiring remains deferred until that acceptance boundary.

The final selected-topology native instruments derive every explicitly prepared
API/realtime/evaluator overlay and reject missing, extra or symlink selections.
This test-only composition repair changes the complete tree identity; it leaves
the five-file runtime delta and production binding behavior unchanged.

The repaired alarm-repeat candidate preserves known producer deadlines through
temporary model unavailability. Its native clinical oracle now distinguishes the
intentional changed B payload from identical early effects, requires the exact
new B frame timestamp/checkpoint, and rejects the original accepted-duplicate
captures. This is an instrument correction, not a waiver of clinical idempotency.
The original failed image/state remain retained; repaired paired acceptance is
measured separately on a fresh image/state.

The current private evaluator inspection exports the runtime's existing due time
and reason, including finite fractional deadlines. It does not change scheduling
or cadence. The unreleased strict private-v2 response requires matching source,
client and schema; an older strict client refuses the added fields. A new exact
image and fresh state qualify this tuple separately from the earlier cd462/0f8749
image. Historical captures retain their original source and missing-state limits.

Host-only socket and clinical completion instruments are joined from e91. They
retain the original minimum observation period, shared maximum deadline and
strict effect/fanout oracle, with bounded typed evidence and session SQL timeouts.
They do not add clinical writes or change runtime producer behavior. The five
common runtime files and their delta remain unchanged by these instruments.

Clinical-job observations expose only existing runtime running, boot and fixed
queued-job slots. Read-only stamp checks are not clinical work. Scheduling,
operation windows and successful-work counters are unchanged; the new paired
private-v2 schema is required. Idle-safety validation belongs to the separately
pinned measurement instrument, with quiet explicitly not a TIME-work witness.

The controlled-replacement host and fixture changes from c10 retain uncertainty
and recovery boundaries, capture typed callback/child diagnostics privately, and
use exact per-attempt nonce probe identities. Legitimate clinical alarms cannot
substitute for a probe. The final probe/session verdict follows all awaited
census checks. Earlier generic publisher failure remains unclassified; a new
exact image and fresh qualification are required, without replaying old state.

Stock/restore qualification establishes each exact API/tenant status cell before
socket/JWT setup. A bare DATA-credential client permits only typed warming during
its bounded request precondition; the measured four public-edge readers still
permit no errors or retries. Successful status bodies and final API boot identities
are validated; request/restore chronology retains typed failures without credentials.
These are host qualification fixtures, with no serving-role or edge behavior change.
The core advance changes only its generic descriptor-version test; runtime inputs
and the five reduced fixture files remain unchanged. A new exact image and native
qualification retain their own source attribution; earlier quiet safety is not TIME work.

The native D6 lab now uses the existing explicit opt-in registration helper. Its
default-tier pending cases are accounted for; enabled empty or skipped labs still
fail execution accounting, and the full native corpus must execute the lab. Only
the test header changes from ff515; every Docker source input and this binding
tree remain unchanged. Prior native evidence keeps its exact attribution.

The unsafe secrets-output fixture now explicitly sets and verifies its intended
readable mode before testing CLI refusal. This test-only core advance preserves
the runtime permission guard, all Docker source inputs and this binding tree.
Original and repaired focused runs retain their actual source/patch attribution.

## Post-baseline joined preparation — 2026-11-12

The recorded core remains `9db0ce94f072c8f34aab889f0181afa4269a6758`.
Original incremental commissioning history `4b0579eace51bc5cd3c02b5a98f0978a41a9cbb1`
and Authentik/resource/probe history `6d2cb6722e9a65f361679f7f9d96c84a39b87c68`
are ordinary-merged after the accepted baseline binding. The primer adds explicit
per-tenant custody/resume behavior; current readiness, controlled replacement,
cadence, authority and isolation implementation is retained. The README overlap
keeps both sets of qualification instructions.

None of core's five reduced fixture files or `SOURCE.delta.patch` changes here;
the delta still covers exactly those upstream files. The full binding-tree pin
above additionally covers the deployment-owned primer, live-add fixture and docs.
Identity-provider tools live outside that binding tree and are pinned by their
selected full deployment/profile commit at private source admission.

Earlier 4b/fba/6d proof retains its executed source and scope. New focused source
admission uses the actual selected core and exact copied binding; real-provider
and shipping live-add execution remain UNMEASURED. A new joined image/native
qualification needs explicit coordinator resource authorization. The running
accepted baseline and its image are not changed or relabelled by this preparation.
