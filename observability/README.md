# Observability

Alert rules for a multitenant deployment: `alerts/multitenant.rules.yml` (20 rules over the metrics core
exports with `NS_METRICS=true`, plus `postgres_exporter` basics), with `alerts/multitenant.rules.test.yml`
(promtool unit tests that fire and stay quiet). Run `alerts/run-tests.sh`. Each alert's `runbook`
annotation names a section of the alignment repository's `docs/30-design/tenancy/operations-runbook.md`.

Thresholds are starting points from the latency objectives (p95 30 s planning, 120 s clinical), not
measured production values. Labels carry no tenant identifiers, credentials or clinical values. The
rules assume the scrape layout of `bindings/kubernetes/lib/ns/lab-metrics.libsonnet` (`job="roles"`
with `workload`, `job="postgres"`); change the matchers if your Prometheus labels differ.

Still to write: dashboards, alerts for failed renewals and disk pressure, backup and restore outcomes.
