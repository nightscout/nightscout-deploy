# Source of `multitenant/`

| field | value |
|---|---|
| upstream repository | nightscout/cgm-remote-monitor |
| upstream path | `deploy/multitenant` |
| upstream commit | `16a1fc2d45e59602eb6ec3e3bf6f506f35bcc5b1` (draft PR #8898, the 2026-11-10 batch join) |
| upstream tree hash of that path | `6529d40282ea4589ea75c71712839d4db6e9940b` |
| import method | file copy of the path at that commit over the earlier import |
| local delta | [`SOURCE.delta.patch`](SOURCE.delta.patch): `config.js` leaves out the `ownership_operator` identity, which [`ownership-admin/`](ownership-admin/) adds |
| tree hash here | `93a4a972f8cb6c6a974c943388d78783148af9f5` |
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
