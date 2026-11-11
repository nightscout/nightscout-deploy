// Preview environment: one cohort, one evaluator pool member, synthetic tenants only.
// Core commit and image tag follow ../../../compose/SOURCE.md (the Compose tree this binds).
local nightscout = import 'ns/nightscout.libsonnet';

nightscout.new({
  namespace: 'nightscout-preview',
  prefix: 'nsdemo',
  sourceCommit: '0392acf97c720a7e121eea47a9d42a0c8dbe9e73',
  images: {
    // `docker tag nightscout-multitenant-demo:local nightscout-multitenant-demo:<sourceCommit>`
    // after build.js --check-image confirms the revision label; then load into the cluster.
    app: 'nightscout-multitenant-demo:0392acf97c720a7e121eea47a9d42a0c8dbe9e73',
  },
})
