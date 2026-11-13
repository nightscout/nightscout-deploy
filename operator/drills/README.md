# Recovery drills

*Contributor- and operator-facing. Each drill rehearses one [runbook](../runbooks/README.md) on a
disposable synthetic Compose project and prints one JSON line per step with what was observed and
what the runbook says should be observed. Synthetic tenants and records only. Measurements from the
2026-11-12 run are in the alignment workspace record `reports/tenancy/recovery-drills-2026-11-12/README.md`.*

## Setup

A prepared deployment of `bindings/compose/multitenant` over a core checkout
(`tools/compose-overlay.sh`, then `node prepare.js --port <port> --state <private directory>`), and
an application image whose labels match the prepared source and deployment revisions.

```bash
export NS_DRILL_CORE=/absolute/core/worktree          # the prepared overlay
export NS_DRILL_PROJECT=recovery-drills-<something>   # any other prefix is refused
export NS_DRILL_IMAGE=<image>                         # labels must match the prepared revisions
# only on a host whose Docker address pools are exhausted:
# export NS_DRILL_BACKEND_SUBNET=<cidr> NS_DRILL_EDGE_SUBNET=<cidr>
operator/drills/stack.sh up
operator/drills/run-all.sh /absolute/new/private/directory
operator/drills/stack.sh destroy --confirm-project "$NS_DRILL_PROJECT"
```

`stack.sh` addresses exactly one Compose project and removes volumes only through `destroy` with the
project named again. The drills set state directories aside (`<state>.aside-*`, `.lost-*`,
`.partial-*`, `.refused-*`) and never delete them; remove them yourself when you are done. The
backup directories hold synthetic data and the synthetic deployment's credentials.

## Drills

| drill | runbook | ends with |
|---|---|---|
| `drill-tenant-restore.sh` | backup-and-restore B | tenant open |
| `drill-host-replacement.sh <backup-dir> [--control tampered-archive\|keys-omitted]` | backup-and-restore C and D, host replacement | deployment healthy, restored from the new backup |
| `drill-whole-deployment-recovery.sh <backup-dir>` | stop conditions 1 and 2, backup-and-restore D | deployment healthy at the backup instant |
| `drill-restore-interruption.sh operator-death-in-transaction\|operator-death-after-data-commit\|participant-death\|lost-acknowledgement` | role death, lost acknowledgement | **tenant A held closed** |
| `drill-restore-resume.sh <the same four modes>` | role death, lost acknowledgement | runs the interruption, then `inspect` and `resume`: tenant open |
| `drill-orphaned-operations.sh` | role death | restore refused with the tenant open, records cleared, restore completed: tenant open |
| `drill-operation-death.sh export\|ownership-admin-death\|ownership-lost-acknowledgement` | role death, lost acknowledgement | deployment healthy |
| `drill-operation-death.sh provision-admin-death\|provision-lost-acknowledgement` | role death, lost acknowledgement | tenants admitted without root custody (stop condition 4) |
| `drill-dependency-restart.sh api-death\|vault-restart\|postgres-restart` | host and dependency replacement | deployment healthy |
| `drill-dependency-restart.sh postgres-outage` (`NS_DRILL_OUTAGE_SECONDS`, default 12) | host and dependency replacement | deployment healthy; needs a core that recovers in place |
| `drill-interrupted-bootstrap.sh source-change` | interrupted upgrade | deployment unchanged |
| `drill-interrupted-bootstrap.sh interrupted` | interrupted upgrade | needs its own prepared, never bootstrapped deployment; ends recreated and bootstrapped |

Exit 0: every step matched. Exit 1: a step differed. Exit 2: the fault did not land where the drill
needs it (`inconclusive`); run it again.

## Controls

A drill that cannot fail proves nothing, so each has a way to break the thing it checks.

| property | control | what goes red |
|---|---|---|
| tenant restore changes state and history | built in: both verifications run before the restore | `DRILL_STATE_MISMATCH`, `DRILL_HISTORY_MISMATCH` |
| an altered artifact is not restored | built in: content changed; stored under another digest | `LIFECYCLE_ARTIFACT_DIGEST`, tenant stays open |
| an interrupted restore holds the tenant closed | `NS_DRILL_SKIP_FAULT=1 drill-restore-interruption.sh <mode>` | the held-closed steps (the restore completes instead) |
| a backup is restored only when intact | `--control tampered-archive` | `RESTORE_ARCHIVE_DIGEST_MISMATCH`, nothing created |
| data is never started without its keys | `--control keys-omitted` | `BOOTSTRAP_VAULT_STATE_CHANGED`, no role starts |
| the census sees a change | built in: census after one new write | differs from the backup census |
| the recovery step is what brings service back | `NS_DRILL_SKIP_RECOVERY=1 drill-dependency-restart.sh <mode>` | the final admitted/restore steps |
| the resume is what reopens the tenant | `NS_DRILL_SKIP_RESUME=1 drill-restore-resume.sh <mode>` | the window, admission and state steps after the resume |
| a resume needs every role to answer | built in (`participant-death`): the resume is tried with realtime stopped | refused; the tenant stays closed |
| the clearance is what lets the restore start | `NS_DRILL_SKIP_CLEARANCE=1 drill-orphaned-operations.sh` | `LIFECYCLE_RESTORE_PREFLIGHT_ORPHANED_OPERATIONS` again; the restore and state steps |
| the roles' own recovery is what brings service back after PostgreSQL | `drill-dependency-restart.sh postgres-restart` on an image built from a core without in-place recovery | `api-health-check-passes` is not the measure there (it passes while tenants are refused); `a-admitted` and the steps after it go red |
| a partial bootstrap is not adopted | built in: start marker set aside | `BOOTSTRAP_OBJECTS_ALREADY_EXIST` |
| the tooling touches only a drill project | `node --test operator/drills/guards.test.js`; remove a guard in a copy and point `NS_DRILL_GUARD_DIR` at it | the matching guard test |

## Files

`stack.sh` (Compose wrapper), `lib.sh` (helpers), `precheck.sh`, `census.sh`, `backup.sh`,
`restore-deployment.sh`, `recover-from-backup.sh` (the operator tools the runbooks name),
`container/drill.cjs` and `container/ownership.cjs` (drivers mounted read-only into the binding's
private operator and lab-client services; they call the shipping `restore.js`, `demo.js` and
`prime.js` unchanged and add only phase holds), `guards.test.js`, `run-all.sh`.

The drills read the lifecycle tables as the database administrator, for inspection only. A tenant is
reopened and an operation record is cleared only through the shipping operator command
(`restore.js inspect|resume|clear-operations`), never by a statement written here.
