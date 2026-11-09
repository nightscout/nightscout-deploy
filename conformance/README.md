# Conformance kits

A kit is the set of checks a provider or a binding must pass, each with a **red control**: a
deliberate break that must make the check fail, with its exact symptom recorded. A kit that has
never gone red is not yet evidence.

| kit | checks (from the alignment decisions and proofs) | state |
|---|---|---|
| `secrets` | tenant/reference-bound envelope; cross-tenant ciphertext refused; key version rotation and rewrap; unavailable provider rejects, never falls back | not started |
| `resolver` | stale snapshot refuses, fresh serves; unknown alias, duplicate selector, conflicting identity fail closed; alias rename keeps identity; reassignment inherits nothing | not started |
| `oidc` | from the Ory proof: isolation across tenants, revocation on next operation, cookie scope, local-first logout, provider outage keeps existing access until expiry and refuses new login | not started |
| `edge` | spoofed forwarded headers, Host conflict, unknown host refused fast, socket upgrades, client IP under the declared peer list | not started |
| `binding` | cold start, restart with a suspended tenant, restore, teardown, pinned images and core commit present in the rendered output | not started |
