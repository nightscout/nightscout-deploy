# Roadmap

What this repository does next, in order. Dependencies on core are listed so the order is visible;
core's own work is tracked in the alignment workspace, not here. The canonical statement of the order
is [claimed public names and the deploy companion, section 3](https://github.com/bewest/rag-nightscout-ecosystem-alignment/blob/main/docs/30-design/tenancy/claimed-public-names-and-deploy-companion-2026-11-09.md).

| step | this repository | needs from core | state |
|---|---|---|---|
| 1 | plan schema extracted from core's `deploy/multitenant/config.js`; `conformance/` kits for secrets and resolver | registry migration, resolver snapshot source | schema drafted; kits not started |
| 2 | Compose binding rendered from the plan; `edge/` reference and probes; `operator/` CLI; `bindings/single/targets.json` checked in CI | headless operator API | Compose tree imported and running; the rest not started |
| 3 | staging run on Compose: TLS edge, identity provider over HTTPS, Vault service login, restore, upgrade and rollback | steps 1 and 2 accepted in core | Vault Agent overlay and ownership-operations overlay written; the rest not started |
| 4 | `bindings/kubernetes/`, `console/`, first two single-tenant targets | thin owner page | not started |
| 5 | owner journeys over the owner API, connector sync tooling, `observability/` | group and schedule policy decision | not started |

`bindings/compose/SOURCE.md` records the core commit the Compose tree is pinned to and the tree hash;
`tools/plan-contract-check.sh` checks the tree hash and, given a core checkout, the plan's generated
role documents against core's deployment plan contract at that commit.
