# Operator tooling

*Operator-facing. Status: the runbooks and drills below are rehearsed on the synthetic single-host
Compose binding only (`bindings/compose/multitenant`, core `debcc2c7`, 2026-11-12). They are not a
production admission of any deployment; the measurements are in the alignment workspace record
`reports/tenancy/recovery-drills-2026-11-12/README.md`.*

| part | state | holds |
|---|---|---|
| [`runbooks/`](runbooks/README.md) | rehearsed on synthetic state | recovery procedures: backup and restore, interrupted bootstrap and source change, a role dying mid-operation, a lost acknowledgement, host and dependency replacement, and the conditions where the operator must stop |
| [`drills/`](drills/README.md) | runnable | the rehearsal of each runbook on a disposable Compose project, with its controls |
| operator CLI | not started | a command-line client for core's operator API: provision, suspend, resume, export, delete, restore, bind, rename and revoke aliases, rotate. The client has no authority of its own; core admits or refuses every request. |
