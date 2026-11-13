# A dependency, a role or the host was restarted or replaced

*Operator-facing. Rehearsed 2026-11-12 on the synthetic Compose binding with one API instance; see
the status line and the stop conditions in [README.md](README.md).*

| what was restarted or replaced | what users see | recovery (rehearsed) |
|---|---|---|
| one application role | API: requests fail (the edge answers 502 or 504) until it is back. Others: that role's output pauses | start that role again. Nothing else is restarted. Then read every tenant's unfinished-operation count ([role-death-mid-operation.md](role-death-mid-operation.md)) |
| Vault (restart, or it comes back sealed) | requests that need a key or a token are refused; the roles stay up | unseal (`stack.sh bootstrap` does only that on a completed deployment). No role is restarted |
| PostgreSQL (restart, or an outage, on the same data) | **every tenant is refused** (the edge answers 503) while PostgreSQL is away and for a few seconds after it is back | with a core that recovers in place (below): none; the roles reconnect by themselves. Verify with a tenant request. With an older core: restart **every** application role, in order: `stack.sh roles-restart` |
| the host, or any volume | everything is down | whole-deployment recovery from a cold backup: [backup-and-restore.md](backup-and-restore.md), part D |

The maintainer decision `realtime-automatic-recovery` (2026-11-12) makes realtime workers restart on
failure and lets a peer take over after a grace period. It is not in this binding yet: the first row
above is still done by hand. See [README.md](README.md), "Decided, and not yet in this source".

## After a PostgreSQL restart or outage

Which behaviour you get depends on the core commit in your image. Core's
`docs/multitenant-datastore-recovery.md` exists in a core that recovers in place; the binding's
recorded core commit is in `bindings/compose/SOURCE.md`.

**With a core that recovers in place** (rehearsed 2026-11-13 on core branch
`claude/datastore-recovery-20261113`, one API instance, two synthetic tenants):

- While PostgreSQL is away each of the api, realtime, evaluator and tenant-admin roles fails its own
  health command, and tenants are refused (503).
- When PostgreSQL is back the roles reconnect by themselves, check that it is the same database
  cluster, and serve again in the same processes. In the rehearsals the edge answered again 1 to 5
  seconds after PostgreSQL accepted connections. No role is restarted.
- Tenants are warmed again in the background. For a short time a request can answer 503 with
  `Retry-After`; clients retry.
- A role that has not recovered after 120 s (`NS_DATASTORE_RECOVERY_BOUND_MS`) exits with status 1.
  **This binding sets `restart: "no"`, so an exited role stays down until you start it**
  (`stack.sh roles-up`). After any outage longer than the bound, check `stack.sh ps`.
- A role does not adopt a different database cluster (for example one initialized again, or restored
  from a logical dump into a new cluster). It stays unhealthy and exits at the bound; starting the
  roles again is then your decision, after you know why the cluster changed.

What to do:

1. Wait for the health commands, then verify with a real tenant request. The container health
   status shown by `docker ps` lags the health command (interval times retries, about a minute in
   this binding), so a short restart may never show `unhealthy` there.
2. Read every tenant's unfinished-operation count ([role-death-mid-operation.md](role-death-mid-operation.md)):
   a request that was in flight when PostgreSQL went away leaves its record unfinished, and a
   tenant-local restore is refused while it remains.
3. A tenant-local restore that was running across the outage is refused. Start it again.

**With an older core** (rehearsed three times on 2026-11-12): the API role's container health check
stays `healthy` while it refuses every tenant, and in one run the tenant-admin process exited on its
own. Run `stack.sh roles-restart` after any PostgreSQL restart without waiting for a health check,
and verify with a real tenant request. A tenant-local restore attempted before the roles are
restarted is refused (`RESTORE_COHORT_DATASTORE_MISMATCH` or `SOCKET_IPC_UNAVAILABLE`) and does
**not** close the tenant.

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

Drills: `drill-dependency-restart.sh api-death | vault-restart | postgres-restart | postgres-outage`, `drill-host-replacement.sh`.
