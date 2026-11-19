// Preview environment: per-role workloads at K=1, synthetic tenants only.
// Exact artifact inputs come from the chosen coherent core/deploy image pair.
local nightscout = import 'ns/nightscout.libsonnet';

nightscout.new({
  namespace: 'nightscout-preview',
  prefix: 'nsdemo',
  sourceCommit: std.extVar('NS_SOURCE_COMMIT'),
  images: {
    // Explicit artifact input. The historical stock image cannot run maintained CDC.
    postgres: std.extVar('NS_PGSTREAM_POSTGRES_IMAGE'),
    // Supply the already-qualified core/deploy image; rendering does not build it.
    app: std.extVar('NS_DEMO_IMAGE'),
  },
})
