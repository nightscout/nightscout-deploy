# Compose binding

`multitenant/` is the Compose tree that came from cgm-remote-monitor's `deploy/multitenant`: first
imported with its history (`git subtree`), then brought up to the core commit `SOURCE.md` records.
This repository is its home; core keeps only the modules its own tests load.

The tree references core by relative path and its Dockerfile builds from the core checkout, so it
runs only overlaid on core at the recorded commit:

```bash
tools/compose-identity-check.sh /path/to/cgm-remote-monitor      # against core at the recorded commit
tools/compose-overlay.sh /path/to/cgm-remote-monitor /tmp/ns-core # a worktree with this tree in place
cd /tmp/ns-core/deploy/multitenant && ./demo.sh prepare           # then as its README says
```

Wave 2 replaces the overlay with rendering from a plan.
