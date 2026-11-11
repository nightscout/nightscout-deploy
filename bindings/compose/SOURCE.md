# Source of `multitenant/`

| field | value |
|---|---|
| upstream repository | nightscout/cgm-remote-monitor |
| upstream path | `deploy/multitenant` |
| upstream commit | `16a1fc2d45e59602eb6ec3e3bf6f506f35bcc5b1` (draft PR #8898, the 2026-11-10 batch join) |
| upstream tree hash of that path | `6529d40282ea4589ea75c71712839d4db6e9940b` |
| import method | file copy of the path at that commit over the earlier import |
| imported on | 2026-11-10 |

History: first imported 2026-11-09 from `ed2ced00c80bd0a6a7d75f834d2c6e2af8c71364` (tree
`8be3d761cbe592428357d6cee29612affafe4122`) by `git subtree`, which keeps the per-file history; the
2026-11-10 copy brings in the 13 core commits (merges included) that touched the path since then.

From core commit `16a1fc2d` onward this repository is the home of the Compose tree. Core keeps a
reduced `deploy/multitenant` with only the modules its own tests load (`config.js`, `demo.js`,
`health.js`, `restore.js`, `ui.js`), so later core commits are not compared with this tree.

The tree references core by relative path (`../../lib/...`) and the Dockerfile builds from the core
checkout, so it runs only overlaid on a core checkout at this commit; `tools/compose-overlay.sh` does
that. When this copy changes, update this file and the recorded hash in the same commit.
