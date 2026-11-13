# A process died in the middle of an operation

*Operator-facing. Rehearsed 2026-11-12 on the synthetic Compose binding; see the status line and the
stop conditions in [README.md](README.md).*

First read the persisted state ([README.md](README.md)). The table says what each death leaves and
what you may do. "Retry" always means the same request with the same identifiers.

| what died, during what | what it leaves (rehearsed) | you may | you must not |
|---|---|---|---|
| the export process, during an export | no artifact; tenant open | run the export again | rename a `.tenant-partial-*` directory into place |
| the admin service, during a provisioning batch | each tenant is either fully admitted or absent; none half-made. Tenants committed before the death have **no root secret in anyone's hands** | restart admin; retry the same batch: the missing tenants are created and their secrets returned; the retry then refuses for the ones already admitted (`PRIMER_PROVISION_REFUSED_OR_CUSTODY_MISSING`) | re-provision under the same identifier expecting a new secret; none is issued. Stop condition 4 |
| the admin service, before an ownership change reached it | the request fails; the owner set is unchanged | restart admin; retry | |
| one cohort role (API, realtime, evaluator, tenant-admin), during a tenant restore | restore refused (`SOCKET_IPC_UNAVAILABLE`); tenant **held closed**; restored rows not committed (audit `suspended`) | restart the role so other tenants are served | run the restore again (refused, `LIFECYCLE_RESTORE_ALREADY_SUSPENDED`); reopen by hand. Stop condition 1 |
| the restore operator, inside the data transaction | tenant **held closed**; restored rows not committed (audit `suspended`) | nothing reopens it | as above. Stop condition 1 |
| the restore operator, after the data commit | tenant **held closed**; restored rows **are** committed (audit `restored`); roles were never told to drop what they cached | nothing reopens it | as above. Stop condition 1 |
| the API role, with requests in flight | the tenant serves again once the role restarts, but **unfinished operation markers remain** | restart the role | start a tenant-local restore on that tenant; clear the markers. Stop condition 2 |

## After any role death

Realtime workers are decided to restart on their own (`realtime-automatic-recovery`); in this binding
no role does yet. Steps 2 to 5 apply either way: an automatic restart brings the process back, not
the tenant that a restore had closed.

1. Restart the dead role (`stack.sh compose up -d --wait <role>`). A restarted role is a new
   incarnation: a restore that had pinned the old one can never complete with the new one.
2. For every tenant: read the window and the unfinished-operation count.
3. A tenant that is `active` with zero unfinished operations needs nothing more.
4. A tenant that is `active` with unfinished operations is serving, and is at stop condition 2: it
   cannot be restored tenant-locally. Rehearsed: the markers are still there after the role restarts,
   the pre-check refuses, and a restore started anyway ends `LIFECYCLE_RESTORE_DRAIN_TIMEOUT` with the
   tenant held closed (`lib/tenant-lifecycle/maintenance-window.js:151` commits the closure before
   line 161 gives up on the drain).
5. A tenant that is `suspended` is at stop condition 1. The other tenants keep working (rehearsed in
   every mode: another tenant completes a write while the first is held, and after).

## While a tenant is held closed

Its users see nothing from this site. Tell them so, and to use their CGM's or pump's own display and
alarms. Then make the stop-condition decision in [README.md](README.md); do not let it sit.

Drills: `drill-operation-death.sh` (export, provisioning, ownership), `drill-restore-interruption.sh`
(the three restore deaths), `drill-orphaned-operations.sh`.
