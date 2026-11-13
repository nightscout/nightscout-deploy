# Compose binding

`multitenant/` is the Compose tree that came from cgm-remote-monitor's `deploy/multitenant`: first
imported with its history (`git subtree`), then brought up to the core commit `SOURCE.md` records.
This repository is its home. Core publishes the deployment plan contract; `tools/plan-contract-check.sh`
checks the documents this plan generates against it at the pinned commit.

The tree references core by relative path and its Dockerfile builds from the core checkout, so it
runs only overlaid on core at the recorded commit:

```bash
tools/plan-contract-check.sh /path/to/cgm-remote-monitor        # the plan against core's contract at the recorded commit
tools/compose-overlay.sh /path/to/cgm-remote-monitor /tmp/ns-core # a worktree with this tree in place
cd /tmp/ns-core/deploy/multitenant && ./demo.sh prepare           # then as its README says
```

Wave 2 replaces the overlay with rendering from a plan.
