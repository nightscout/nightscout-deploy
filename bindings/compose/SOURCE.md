# Source of `multitenant/`

| field | value |
|---|---|
| upstream repository | nightscout/cgm-remote-monitor |
| upstream path | `deploy/multitenant` |
| upstream commit | `ed2ced00c80bd0a6a7d75f834d2c6e2af8c71364` (draft PR #8898 accepted one-host candidate) |
| upstream tree hash of that path | `8be3d761cbe592428357d6cee29612affafe4122` |
| import method | `git subtree split -P deploy/multitenant` at that commit (25 commits), then `git subtree add` here |
| imported on | 2026-11-09 |

The imported tree is byte-identical to the upstream path at that commit (`tools/compose-identity-check.sh`).
Its files reference core by relative path (`../../lib/...`) and the Dockerfile builds from the core
checkout, so it runs only when overlaid on a core checkout at this commit; `tools/compose-overlay.sh`
does that. Once this copy diverges from core, update this file and the check's recorded hash in the
same commit, and remove core's copy.
