# Compose binding

Holds cgm-remote-monitor's `deploy/multitenant` tree, moved here with its history
(`git subtree split`) from the draft PR branch, with the source commit recorded in `SOURCE.md`
when the move lands. The accepted one-host reference (`ed2ced00`) keeps its attribution because the
files it cites are unchanged, only relocated; core keeps a one-paragraph pointer.

Checks: `tools/compose-identity-check.sh` (to write) compares this tree byte for byte against the
recorded core commit, and `demo.sh` remains the smoke. No acceptance campaign is re-run for the
move. Wave 2 adds rendering of the tree's inputs from a plan.
