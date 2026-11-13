# A dependency, a role or the host was restarted or replaced

*Operator-facing. Rehearsed 2026-11-12 on the synthetic Compose binding with one API instance; see
the status line and the stop conditions in [README.md](README.md).*

| what was restarted or replaced | what users see | recovery (rehearsed) |
|---|---|---|
| one application role | API: requests fail (the edge answers 502 or 504) until it is back. Others: that role's output pauses | start that role again. Nothing else is restarted. Then read every tenant's unfinished-operation count ([role-death-mid-operation.md](role-death-mid-operation.md)) |
| Vault (restart, or it comes back sealed) | requests that need a key or a token are refused; the roles stay up | unseal (`stack.sh bootstrap` does only that on a completed deployment). No role is restarted |
| PostgreSQL (restart on the same data) | **every tenant is refused** (the edge answers 503) and stays refused | restart **every** application role, in order: `stack.sh roles-restart` |
| the host, or any volume | everything is down | whole-deployment recovery from a cold backup: [backup-and-restore.md](backup-and-restore.md), part D |

The maintainer decision `realtime-automatic-recovery` (2026-11-12) makes realtime workers restart on
failure and lets a peer take over after a grace period. It is not in this binding yet: the first row
above is still done by hand. See [README.md](README.md), "Decided, and not yet in this source".

## After a PostgreSQL restart, do not trust the health checks

Rehearsed three times, same result: after PostgreSQL restarts, the API role's container health check
stays `healthy` while it refuses every tenant. Each role proved, when it started, which exact
database server it is talking to, and refuses to carry on against a different server start. The
health check does not ask a tenant question. In one of the runs the tenant-admin process also exited
on its own. So:

1. After any PostgreSQL restart, planned or not, run `stack.sh roles-restart` without waiting for a
   health check to tell you.
2. Verify with a real tenant request, not with container health.
3. A tenant-local restore attempted before the roles are restarted is refused
   (`RESTORE_COHORT_DATASTORE_MISMATCH` or `SOCKET_IPC_UNAVAILABLE`) and does **not** close the tenant.
   Still, restart the roles first.

## After a Vault restart

The Vault comes back sealed. Unsealing needs the unseal material, which in the lab binding is one
share kept in the private state directory; in a real deployment it is whatever custody you set up,
and if nobody who holds it can be reached, the deployment stays down. Rehearse that reachability.
Once unsealed, service resumes without restarting a role.

## Replacing the host

There is no procedure that moves a running deployment. Replacement is: a cold backup exists; the new
host has the same prepared source and deployment revisions and the same state path; whole-deployment
recovery; verification of state and of history; then users are told what window was lost. Rehearsed
as a loss of every volume on one machine (`drill-host-replacement.sh`). A different machine, a
different state path and public name changes are `UNMEASURED`.

Drills: `drill-dependency-restart.sh api-death | vault-restart | postgres-restart`, `drill-host-replacement.sh`.
