# Compose binding

Consumes cgm-remote-monitor's `deploy/multitenant` at a pinned commit (first pin: `ed2ced00`, the
accepted one-host reference) and renders its inputs from a plan. The deployment itself stays in
core through 16.0.0 preview acceptance so the accepted evidence keeps its source; this binding is a
renderer and a pin until the sibling's first release.

Wave 2 gate: a plan instance renders the same per-role config, environment, operation, admission
and UI documents the reference produces, compared byte for byte.
