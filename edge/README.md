# Edge

Holds one template: [`trust-record.template.md`](trust-record.template.md), which a deployment fills
before admission. Will also hold the reference nginx for the Compose and Kubernetes bindings and the
probes that run against a live edge (spoofed headers, Host conflict, unknown host, socket upgrade,
client IP). Not started beyond the template; the Compose binding carries its own nginx.

Rules the reference will encode: the public Host is preserved; caller forwarded and selector headers
are stripped and the edge sets its own; an unknown host is refused before any tenant context exists;
management, operator and database endpoints have no public route.
