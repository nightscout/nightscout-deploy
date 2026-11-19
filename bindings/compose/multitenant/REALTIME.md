# Realtime worker ownership

`NS_REALTIME_WORKERS` selects one to eight stable Compose workers at preparation.
The default is one. Each worker owns tenants whose hash modulo the count equals
its ordinal. The socket edge uses the same function to route each tenant to its
owner. The evaluator sends each wake to that tenant's realtime worker.

For a Compose count change, stop the old workers and edge before starting the
prepared topology for the new count. Kubernetes uses StatefulSet ordinals and
the headless peer Service. A pod outside the configured count owns no tenants.
See the tests in `static-ownership.test.js` and the Kubernetes binding in
`bindings/kubernetes/lib/ns/components.libsonnet`.
