// Preview environment: one cohort, one evaluator pool member, synthetic tenants only.
// Core commit and image tag follow ../../../compose/SOURCE.md (the Compose tree this binds).
local nightscout = import 'ns/nightscout.libsonnet';

nightscout.new({
  namespace: 'nightscout-preview',
  prefix: 'nsdemo',
  sourceCommit: '16a1fc2d45e59602eb6ec3e3bf6f506f35bcc5b1',
  images: {
    // `docker tag nightscout-multitenant-demo:local nightscout-multitenant-demo:<sourceCommit>`
    // after build.js --check-image confirms the revision label; then load into the cluster.
    app: 'nightscout-multitenant-demo:16a1fc2d45e59602eb6ec3e3bf6f506f35bcc5b1',
  },
})
