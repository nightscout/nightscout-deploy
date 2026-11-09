# Edge

Reference nginx for the Compose and Kubernetes bindings, the trust-record template a deployment
fills before admission, and the probes that run against a live edge: spoof, conflict, unknown
host, socket upgrade, client IP.

Rules the reference encodes: the public Host is preserved for direct-alias resolution; caller
forwarded and selector headers are stripped and the edge sets its own; an unknown host is refused
at the edge before any tenant context is allocated; management, operator and database endpoints
have no public route.
