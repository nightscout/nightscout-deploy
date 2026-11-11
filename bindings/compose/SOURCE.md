# Source of `multitenant/`

| field | value |
|---|---|
| upstream repository | nightscout/cgm-remote-monitor |
| upstream path | `deploy/multitenant` |
| upstream commit | `16a1fc2d45e59602eb6ec3e3bf6f506f35bcc5b1` (draft PR #8898, the 2026-11-10 batch join) |
| upstream tree hash of that path | `6529d40282ea4589ea75c71712839d4db6e9940b` |
| import method | file copy of the path at that commit over the earlier import |
| local delta | [`SOURCE.delta.patch`](SOURCE.delta.patch): `config.js` leaves out the `ownership_operator` identity, which [`ownership-admin/`](ownership-admin/) adds; `root_writer` gets the lower-role control-schema reads (bench fix 1, below) |
| tree hash here | `eb4898b82e16cf8368e88ed7042058764cd64bc9` |
| imported on | 2026-11-10 |

History: first imported 2026-11-09 from `ed2ced00c80bd0a6a7d75f834d2c6e2af8c71364` (tree
`8be3d761cbe592428357d6cee29612affafe4122`) by `git subtree`, which keeps the per-file history; the
2026-11-10 copy brings in the 13 core commits (merges included) that touched the path since then.

From core commit `16a1fc2d` onward this repository is the home of the Compose tree. Core keeps a
reduced `deploy/multitenant` with only the modules its own tests load (`config.js`, `demo.js`,
`health.js`, `restore.js`, `ui.js`), so later core commits are not compared with this tree.

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
