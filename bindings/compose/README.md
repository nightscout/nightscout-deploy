# Compose binding

`multitenant/` is cgm-remote-monitor's `deploy/multitenant` tree, imported with its history
(`git subtree`) from the accepted one-host candidate; `SOURCE.md` records the commit and tree hash.
The accepted reference keeps its attribution because the files are unchanged, only relocated.

The tree references core by relative path and its Dockerfile builds from the core checkout, so it
runs only overlaid on core at the recorded commit:

```bash
tools/compose-identity-check.sh /path/to/cgm-remote-monitor      # byte identity against core
tools/compose-overlay.sh /path/to/cgm-remote-monitor /tmp/ns-core # a worktree with this tree in place
cd /tmp/ns-core/deploy/multitenant && ./demo.sh prepare           # then as its README says
```

No acceptance campaign is re-run for the move. Wave 2 replaces the overlay with rendering from a
plan and removes core's copy.
