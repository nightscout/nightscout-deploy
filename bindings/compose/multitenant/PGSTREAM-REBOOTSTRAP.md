# Explicit populated pgstream rebootstrap

The host operator command replaces one explicitly selected missing or lost
`wal2json` replication slot in an existing Compose deployment. It never runs
`pgstream init`, provisions a schema, changes runtime grants, clears a checkpoint
or starts a service. The existing supervisor continues to fail closed with
`PGSTREAM_REBOOTSTRAP_REQUIRED`. This command is separate from that supervisor.

Source controls reproduce command-level refusal and success on a synthetic
platform. Actual Docker/PostgreSQL populated recovery is **UNMEASURED** until the
recorded native case runs. The command's successful state means only that the
slot exists and effect-serving containers remain stopped. It does not mean that
clinical reconciliation or external effects have resumed.

## Operator custody and private plan

Use exclusive deployment/platform and DBA custody. Stop every application,
relay, ingress and one-shot operator container in the prepared Compose project.
PostgreSQL and Vault remain running. Keep orchestrators, other operators and
external database writers from starting work during recovery. A competing
privileged platform operator can invalidate any process-exclusion observation;
this command does not fence a buffered network send or another Docker authority.

The command accepts a private JSON plan, never a loader/provider path. Keep it
outside version control. Its fields are:

| Field | Required current binding |
|---|---|
| `version`, `action` | `1`; `create-missing` or `replace-lost` |
| `project`, `deploymentDirectory`, `stateDirectory`, `composeFiles`, `environmentFile` | Existing prepared project, absolute paths, exact current ordered Compose file list and explicit active environment file (default `.env` in deployment directory) |
| `source` | `coreCommit` and `deployCommit` from prepared bootstrap and immutable application image labels |
| `imageId`, `postgresImageId` | Actual immutable Docker image IDs, never floating tags |
| `database` | Exact `name`, `oid`, `systemIdentifier`, `postmasterStartedAt` from the current physical PostgreSQL instance |
| `slot`, `operatorRole` | Existing configured selected slot and explicit DBA principal used through local `psql` in that PostgreSQL container |
| `evaluatorConfig`, `evaluatorConfigSha256`, `wireConfigSha256` | Existing evaluator private `config.json` and independently recorded SHA256 of it and sibling `pgstream.yaml` |
| `containers` | Every existing project container: exact `cid`, `service`, `imageId`, `startedAt`, `configHash` from actual Docker inspection; optional exact per-container ordered `composeFiles` lineage and `originalRestartPolicy` |
| `receiptFile` | New absolute private output path; existing files are refused |

A plan is an identity expectation, not process-exclusion evidence. The command
runs actual Docker inspection again and requires the whole current project to
match the plan. Every non-infrastructure container must be not running, PID zero,
not paused, and have restart policy `no`. It checks each recorded per-service Compose file lineage exactly (an ordered prefix of the selected current files), and independently recomputes current effective per-service Compose hashes. A service created before a scoped observer override may retain its shorter lineage only when its current effective hash remains identical. Unknown lineage or changed effective config refuses. It also checks Compose configuration labels,
source/image bindings, read-only evaluator config mount and absence of application
source mounts. A missing container, changed incarnation, changed config or an
unresponsive/live process refuses the operation. No recovery-owner test label is
part of this contract. Runtime application images must be the canonical immutable
image; nginx may use its separately pinned image.

The DBA query checks physical database/system/postmaster identity, no remaining
client or WAL-sender backends, the existing nonowner replication runtime role and
its current least grants, exact clock/settings/policy/activity/lifecycle/output/
heartbeat subscriptions, and selected slot state. A valid slot is refused rather
than reset. A lost slot must be inactive, belong to this database and use
`wal2json`. The mutation session repeats database/no-backend/slot conditions and
serializes competing instances of this operator with a session advisory lock.
That lock is operator serialization, not an old-process/effect fence.

## Host installation and restart policy

Install the reviewed helper in a NEW owned host context containing the exact core
commit named by the plan and matching lockfile dependencies. The relative core
route import is fixed (`../../lib/pgstream/evaluator`); the plan does not select a
module path. A standalone nightscout-deploy checkout lacks that installed core
context and is not the executable operator installation. Do not edit the frozen
core checkout or pretend its older image includes this new helper.

For an archive installation, export core at the exact plan commit into a new
empty owned directory, then export only this committed helper into that archive's
`deploy/multitenant/pgstream-rebootstrap.js`. Install or attach separately verified
matching dependencies for that core lockfile. Record the core archive commit,
operator deployment commit and helper SHA256 separately from the running image's
core/deployment labels. Run the direct host Node command below from this context.
The `demo.sh` alias is available when the complete reviewed deployment overlay is
installed; its source attribution is likewise separate from the running image.

Docker may retain a deliberate `on-failure:3` evaluator policy after a confirmed
stop. Under exclusive platform custody, first inspect the exact stopped CID and
record its original `HostConfig.RestartPolicy` in the plan/receipt. Require actual
`Running=false`, `Pid=0`, `Paused=false` and the expected incarnation before:

```bash
docker update --restart=no "$EVALUATOR_CID"
docker inspect "$EVALUATOR_CID"
```

Recheck the exact CID, incarnation, image, config hash, stopped state and actual
policy `no`; do this for every stopped application with a non-`no` policy. The
helper never silently updates policies and still refuses any active restart
policy. After successful slot recovery and operator disposition, restore the
**exact recorded** policy only immediately before deliberately starting that same
evaluator alone. For a recorded `on-failure`/`MaximumRetryCount=3`:

```bash
docker update --restart=on-failure:3 "$EVALUATOR_CID"
# Reinspect exact identity/state/policy, then deliberate evaluator-only start.
```

Do not restore other effect-serving policies or start their containers yet. If a
new evaluator container must be created, bind the new OS incarnation/config/image
explicitly through existing platform admission; an old CID receipt is not proof
for that replacement. An interrupted operation leaves policies disabled and all
effects stopped until the operator inspects actual state.

## Run and recover

From the prepared Compose directory, with the reviewed operator helper installed:

```bash
./demo.sh pgstream-rebootstrap /absolute/private-plan.json
# Equivalent callable host operation:
node pgstream-rebootstrap.js /absolute/private-plan.json
```

The host uses its Docker authority and the explicit local DBA principal. It gives
no serving role a new credential or privilege. No password or connection URL is
passed in the plan or printed. Diagnostics expose only stable refusal codes.
The command creates or replaces the slot and verifies it, retaining the original
subscriptions/grants and all durable tables. It leaves every application stopped.
An error, timeout or interruption must keep the deployment stopped. A partial
receipt (`SLOT_OPERATION_STARTED`) means outcome unknown: inspect actual slot and
DB backends before any new attempt. Do not retry a timed-out physical operation
while its backend could still be active. An existing valid slot is not evidence
that reconciliation completed.

Next, use the same prepared Compose arguments and canonical image to start **only
the evaluator**, with `--no-deps --no-build --pull never`. Do not use `demo.sh up`:
that command starts other effects and performs demonstration setup. The existing
evaluator first establishes received heartbeat/stream coverage, then verifies and
scans current tenant metadata and commits bootstrap reconciliation. Its indexed
pending/due work reconstructs clinical progress without resetting persisted ages,
versions, output revision, notification identity or due clocks.

Before explicitly reopening other services, independently compare current physical
clinical/control clocks with observed/completed/input checkpoints and current
output identity, and verify retained overdue work completes without another
clinical write. Require no pending or named clinical refusal, current owner and
restore generation, and complete tenant coverage for this deployment. Future due
work remains scheduled at its real declared instant; it need not fire early.
Health alone is insufficient. Keep effects stopped on an incomplete oracle or
any refusal. Record the exact evaluator-only start command and all old/new OS
incarnations in the operator evidence. Reopen the remaining cohort only through
its existing admission/restore protocols, with explicit operator disposition.

Full initial DBA setup is not a recovery alternative: it creates tables,
subscriptions and policies. Silent supervisor slot recreation is not an
alternative either: it would skip the explicit stream-coverage/reconciliation
boundary. This operation preserves those boundaries instead of manufacturing
completion counters or extending product deadlines.
