# Edge

Reference nginx for the Compose and Kubernetes bindings, the trust-record template a deployment
fills before admission, and the probes that run against a live edge: spoof, conflict, unknown
host, socket upgrade, client IP.

Rules the reference encodes: the public Host is preserved for direct-alias resolution; caller
forwarded and selector headers are stripped and the edge sets its own; an unknown host is refused
at the edge before any tenant context is allocated; management, operator and database endpoints
have no public route.

## `auth_request` facade

For edges that resolve a tenant before proxying, this directory will ship a small demo facade: it
answers the edge's `auth_request` by calling core's read-only resolution endpoint on the private
plane, caches by snapshot version, and returns the tenant selector and policy headers the edge
needs. It holds no authority of its own: core still refuses unknown hosts and applies the alias
policy on every exposed path. A hosting operator may replace the facade behind the same endpoint.
