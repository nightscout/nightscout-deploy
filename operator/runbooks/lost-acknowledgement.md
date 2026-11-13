# A reply never arrived

*Operator-facing. Rehearsed 2026-11-12 on the synthetic Compose binding; see the status line and the
stop conditions in [README.md](README.md).*

A lost reply means you do not know whether the work happened. The rule is the same every time:
**read first, then decide; never send the request again just to see.**

| request whose reply was lost | read | then (rehearsed unless marked) |
|---|---|---|
| ownership change (add, transfer, recover an owner) | list the owners | If the change is there, you are done. Sending the identical request again is refused (`OWNERSHIP_CONFLICT`) and applies nothing twice, because each request names the owner set it expects. If the change is not there, send it again |
| provisioning (one tenant or a batch) | the registry: is each tenant there and `active`? | Tenants that are there were admitted and their root secret was in the lost reply. A retry does not issue another one and is refused. Stop condition 4. Tenants that are not there: retry the same identifiers |
| export | the artifacts directory | No artifact with a new digest: run it again |
| a cohort role's acknowledgement during a tenant restore (the role is hung, paused or unreachable after the restored rows were committed) | window and audit | The restore is refused once the role's reply time runs out (about 10 seconds in the rehearsal; the per-role limit is 5,000 ms in the binding's plan). Window `suspended`, audit `restored`: the rows are committed and the tenant is held closed. It stays closed when the role comes back. Stop condition 1 |
| the database's reply to a commit inside a restore (`..._OUTCOME_UNCERTAIN`) | window and audit | Stop condition 3. Read-derived; not rehearsed |
| the reply to the final reopening of a restore (`LIFECYCLE_RESTORE_ACTIVATION_OUTCOME_UNCERTAIN`) | window | It may already be `active`. If it is, the restore finished; verify state and history as in [backup-and-restore.md](backup-and-restore.md). If it is `suspended`, stop condition 1. Read-derived; not rehearsed |

Why a restore is never simply repeated: the first attempt may have committed the restored rows. The
roles are told to drop what they cached only after that commit, and the tenant is reopened only after
every one of them has answered. Reopening without those answers would let a role serve what it
cached from before the restore.

Drills: `drill-operation-death.sh ownership-lost-acknowledgement`,
`drill-operation-death.sh provision-lost-acknowledgement`, `drill-restore-interruption.sh lost-acknowledgement`.
