# Operator CLI

A thin client over core's headless operator API on the private plane. Verbs follow the lifecycle
library and the alias registry: `provision`, `suspend`, `resume`, `export`, `delete` (request,
confirm, cancel), `restore`, `bind-alias`, `rename-alias`, `revoke-alias`, `rotate`. The CLI holds
no authority of its own; every verb is refused or admitted by core's current-authority checks.
Not started; depends on the registry API and operator verbs landing in core (wave 1–2).
