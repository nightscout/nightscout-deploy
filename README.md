# nightscout-deploy

Deployment companion for [cgm-remote-monitor](https://github.com/nightscout/cgm-remote-monitor),
the Nightscout server. It holds the one-host Compose deployment of multitenant Nightscout (several
tenants behind one edge, PostgreSQL, Vault) and the overlays that extend it, with places reserved for
Kubernetes, single-tenant targets, an operator CLI and conformance kits. Home:
[github.com/nightscout/nightscout-deploy](https://github.com/nightscout/nightscout-deploy). Licence: AGPL-3.0-only.

## What runs today

| what | where | what it does |
|---|---|---|
| Compose binding | [`bindings/compose/`](bindings/compose/) | one host: API, realtime, evaluator, tenant-admin, web pages, nginx, PostgreSQL and TLS-enabled Vault, with synthetic tenants and generated credentials |
| Vault Agent overlay | [`bindings/compose/vault-agent/`](bindings/compose/vault-agent/) | a Vault Agent sidecar logs in and renews the token the application reads for Transit calls |
| Ownership-operations overlay | [`bindings/compose/ownership-admin/`](bindings/compose/ownership-admin/) | the `admin` service and the `ownership_operator` database identity with its grants |

The Compose tree came from core's `deploy/multitenant` and lives here now; core keeps only the
modules its tests load. It builds from a core checkout, so it runs overlaid on core at the recorded
commit.

**Core commit pinned:** `16a1fc2d45e59602eb6ec3e3bf6f506f35bcc5b1`, the 2026-11-10 head of core's
draft pull request [#8898](https://github.com/nightscout/cgm-remote-monitor/pull/8898). It carries
the `admin` role and the Vault token-file reader both overlays need. The source, tree hash and import
method are in [`bindings/compose/SOURCE.md`](bindings/compose/SOURCE.md).

## Run the Compose binding

Needs Docker Engine with Compose v2, Node.js 22 or newer, OpenSSL, and a host user with uid and gid 1000.
From this repository:

```bash
tools/compose-identity-check.sh /path/to/cgm-remote-monitor        # the tree matches core at the pinned commit
tools/compose-overlay.sh /path/to/cgm-remote-monitor /tmp/ns-core   # a core worktree with this tree in place
cd /tmp/ns-core/deploy/multitenant
./demo.sh prepare       # then build, bootstrap, up and demo, as bindings/compose/multitenant/README.md says
```

Everything it creates is synthetic. Keep real records and identities out of it.

## Run the Vault Agent overlay

Requires a core checkout that accepts a token file for Vault (`tokenFile`; the pinned commit has
it). From [`bindings/compose/vault-agent/`](bindings/compose/vault-agent/):

```bash
./vault-agent.sh <core-tree> up        # imported bootstrap, agent provisioning, then every role
./vault-agent.sh <core-tree> demo      # the restore demonstration through the overlay
./vault-agent.sh <core-tree> destroy   # down -v
```

The overlay's README has the full steps (prepare, build, token lifetime variables), the credential
locations and the measured results. The ownership-operations overlay runs the same way with
`ownership-admin.sh`; the pinned commit has the `admin` role it needs.

## Not started

Each directory holds a short note on what it will contain.

| directory | what it will hold | state |
|---|---|---|
| [`plan/`](plan/) | the deployment-plan schema every binding renders from | draft schema only |
| [`bindings/kubernetes/`](bindings/kubernetes/) | Kubernetes binding | not started |
| [`bindings/single/`](bindings/single/) | single-tenant targets, each with an owner and expiry date | registry and checker, no targets |
| [`providers/`](providers/) | provider interfaces and naming rule | not started |
| [`conformance/`](conformance/) | checks each provider and binding must pass | not started |
| [`edge/`](edge/) | reference nginx, trust-record template, probes | template only |
| [`operator/`](operator/) | operator command-line client | not started |
| [`console/`](console/) | read-mostly operator console | not started |
| [`observability/`](observability/) | dashboards, alert rules, runbooks | not started |

Order of work: [docs/roadmap.md](docs/roadmap.md). Split between this repository, core and a hosting
operator's private adapters: [docs/scope-split.md](docs/scope-split.md).

## Checks

```bash
npm test    # the single-target registry check and the Compose identity check
```

## Working on it

[AGENTS.md](AGENTS.md) has the rules: synthetic data only, no credentials in files, every claim
labelled read-derived or measured, a check proves something only after it has gone red once.
Rationale and decisions live in the alignment workspace, linked from where they apply, for example
[claimed public names and the deploy companion](https://github.com/bewest/rag-nightscout-ecosystem-alignment/blob/main/docs/30-design/tenancy/claimed-public-names-and-deploy-companion-2026-11-09.md).

## Licence

AGPL-3.0-only, the same as cgm-remote-monitor, nightscout-connect and the imported Compose tree. See
[LICENSE](LICENSE).
