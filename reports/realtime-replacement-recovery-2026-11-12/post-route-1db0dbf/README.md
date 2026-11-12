# Post-route lost-completion discriminator

[Exact source, scope and assertions](proof.json) supplement the [original focused
proof](../proof.json). Production helper/journal/publisher files remain unchanged
from bb0b795. The additional injected failure occurs after actual filesystem route
publication and before host journal completion. It leaves a running intended boot
and matching candidate backend/routes, refuses ordinary retry, then explicitly
recovers through a fresh generation. Both process and actual Docker platform
fixtures pass. Product fence/readiness remains instrumented, so joined clinical,
alarm and restore acceptance stays parent-owned. Fault exceptions reproduce the
interrupted durable state; this does not measure physical power-loss behavior.
