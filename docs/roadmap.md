# Roadmap: line of sight to a staging rehearsal

Waves show dependency, not dates. Each wave ends at a gate. Core rows are listed so the order is
visible; they are tracked in the alignment workspace queue, not here. The canonical statement of
this order is the alignment note
[claimed public names and the deploy companion §3](https://github.com/bewest/rag-nightscout-ecosystem-alignment/blob/main/docs/30-design/tenancy/claimed-public-names-and-deploy-companion-2026-11-09.md);
this file tracks only this repository's part of it.

"Rehearsal" means: a synthetic export of a few tenants loaded into the Compose binding on a
clean host, served through a TLS edge with a written trust record, restored once. Nothing real.

| wave | this repository | depends on (core) | gate |
|---|---|---|---|
| 1 | repository scaffold; `plan/schema` extracted from core's `deploy/multitenant/config.js`; `conformance/resolver` and `conformance/secrets` kits with red controls | registry migration and operator API; resolver snapshot-source interface; unknown-host refusal before tenant context | kits go red on a broken provider and green on the reference |
| 2 | `bindings/compose` consumes `deploy/multitenant` at a pinned commit and renders from the plan; `edge/` reference with probes and trust-record template; `operator/` CLI verbs; `targets.json` checked in CI | full Mongo→PostgreSQL loader; headless operator API verbs | plan → Compose round trip reproduces the accepted reference byte for byte on its documents; CLI provision/suspend/export/delete/bind-alias measured against the binding |
| 3 | **staging rehearsal** on Compose: TLS edge, identity provider over HTTPS, Vault service login, backup and restore of the assembled tree, upgrade and rollback | wave 0 and 1 acceptance in core | deployment admission probes pass against the live edge and Vault; one restore rehearsed; trust record written |
| 4 | `bindings/kubernetes` (one Pod per cohort, private socket volume, no-overlap update); `console/` read-mostly; first two `bindings/single` targets with owners and expiry | thin owner page | binding equivalence table satisfied; targets smoke tests run in CI |
| 5 | WWW journeys over the owner API; connector sync tooling; `observability/` mixin | group/schedule policy decision | policy evidence list in the public-name contract |

## Status

| wave | state | evidence |
|---|---|---|
| 1 | scaffold written 2026-11-09; schema is a draft; kits not started | this commit |
| 2–5 | not started | — |
