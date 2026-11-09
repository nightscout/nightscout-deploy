# nightscout-deploy

Deployment companion for [cgm-remote-monitor](https://github.com/nightscout/cgm-remote-monitor):
one deployment plan, several renderers (Compose, Kubernetes, DIY single-tenant targets), the
providers a hosting operator installs behind core's interfaces, the conformance kits those
providers must pass, the reference edge, the operator CLI and the operations material.

**Status: scaffold, 2026-11-09, in flux.** Work lands directly on `main` while the shape settles; gates tighten as pieces stabilise. The Compose tree runs (see `bindings/compose/`); the rest is notes. Layout, interfaces and the roadmap are
written; code lands wave by wave (see [docs/roadmap.md](docs/roadmap.md)). Rationale and the scope
split between this repository, core and a hoster's private adapters are recorded in the alignment
workspace: [claimed public names and the deploy companion](https://github.com/bewest/rag-nightscout-ecosystem-alignment/blob/main/docs/30-design/tenancy/claimed-public-names-and-deploy-companion-2026-11-09.md).

Anchors at the time of writing: cgm-remote-monitor draft PR #8898 candidate `ed2ced00`
(the one-host Compose reference this repository will consume), alignment `main` `9029fb6dd`.

## What this repository is for

- **Lower the cost of running Nightscout**, single-tenant or multitenant, by giving every
  deployment shape the same plan and the same checks.
- **Keep vendor details out of core.** Pricing and availability change; a target here has an
  owner and an expiry date, and an expired target fails CI instead of going stale in a guide.
- **Let a hosting operator inject adapters, not forks.** Secrets providers, identity-provider
  profiles, an ephemeral alias issuer and a registry snapshot source are installed packages that
  pass the kits in `conformance/`. Config names a registered provider; it never names a module path.

## What it is not

- Not a place for authority or identity rules. The registry schema, the resolver, the OIDC
  adapter contract, owner authority and the headless owner/operator APIs live in core.
- Not a login UI. Identity providers bring their own.
- Not billing, signup, marketing or support tooling.

## Layout

| path | holds | state |
|---|---|---|
| `plan/` | the deployment-plan schema and the reference renderer inputs | schema draft |
| `bindings/compose/` | the Compose binding; consumes core's `deploy/multitenant` at a pinned commit | notes |
| `bindings/kubernetes/` | one Pod per application cohort, private socket volume, no-overlap update | notes |
| `bindings/single/` | DIY single-tenant targets (`single` role, MongoDB) with owner and expiry | registry, empty |
| `providers/` | provider interfaces, naming and registration rule | notes |
| `conformance/` | kits with red controls: secrets, resolver, OIDC, edge, binding | notes |
| `edge/` | reference nginx, trust-record template, probes | template |
| `operator/` | CLI over core's headless operator API | notes |
| `console/` | read-mostly operator console over the same API | deferred |
| `observability/` | Grafana mixin, alert rules, runbook skeletons | notes |
| `tools/` | repository checks (`targets-check.js`) | runs |

```bash
npm test   # runs the repository checks; today: the targets registry
```

## Working rules

See [AGENTS.md](AGENTS.md). In one line: synthetic data only, no credentials anywhere, label every
claim read-derived or measured, and a check that has never gone red is not yet evidence.

## Licence

To be decided with the maintainers before any release; the intent is the same licence family as
cgm-remote-monitor.
