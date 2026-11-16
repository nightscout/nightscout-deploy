# Explicit populated pgstream rebootstrap

The host operator command replaces one explicitly selected missing or lost
`wal2json` replication slot in an existing Compose deployment. It never runs
`pgstream init`, provisions a schema, changes runtime grants, clears a checkpoint
or starts a service. The evaluator refuses observed slot loss with
`PGSTREAM_REBOOTSTRAP_REQUIRED` and exits. The independent platform-managed
pgstream service also refuses a missing slot during ordinary startup; its restart
policy does not recreate the slot. This host command is the explicit recovery
operation.

Source controls reproduce command-level refusal and success on a synthetic
platform. An isolated single-host PostgreSQL/Vault/evaluator/pgstream project
also reproduces the canonical-image CLI, followed by overdue clinical work and
a second tenant's startup write. The
[alignment measurement record](https://github.com/bewest/rag-nightscout-ecosystem-alignment/blob/main/reports/tenancy/switch-over-finish-2026-11-15/operational-rebootstrap.json)
binds the exact source, image, controls, retained evidence and limits. The current ordinary-profile rehearsal below adds populated serving/client recovery;
other deployment profiles, WAL exhaustion and capacity remain **UNMEASURED**.
The command's successful state means only that the slot exists and effect-serving
containers remain stopped. Clinical reconciliation and reopening effects require
the independent checks below.

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
| `approvedHistoricalComposeFiles` | Explicit ordered approved historical/current file set, each with absolute `path` and current `sha256`; includes every selected or recorded lineage file |
| `source` | `coreCommit` and `deployCommit` from prepared bootstrap and immutable application image labels |
| `imageId`, `postgresImageId` | Actual immutable Docker image IDs, never floating tags |
| `database` | Exact `name`, `oid`, `systemIdentifier`, `postmasterStartedAt` from the current physical PostgreSQL instance |
| `slot`, `operatorRole` | Existing configured selected slot and explicit DBA principal used through local `psql` in that PostgreSQL container |
| `evaluatorConfig`, `evaluatorConfigSha256`, `wireConfigSha256` | Existing evaluator private `config.json` and independently recorded SHA256 of it and the separate `pgstream/pgstream.yaml` |
| `containers` | Every existing project container: exact `cid`, `service`, `imageId`, `startedAt`, `configHash` from actual Docker inspection; optional exact per-container ordered `composeFiles` lineage and `originalRestartPolicy` |
| `receiptFile` | New absolute private output path; existing files are refused |

A plan is an identity expectation, not process-exclusion evidence. The command
runs actual Docker inspection again and requires the whole current project to
match the plan. Every non-infrastructure container, including the independent pgstream worker, must be not running, PID zero,
not paused, and have restart policy `no`. It checks each recorded per-service Compose file lineage exactly against the explicitly approved file set and order. It hashes every approved file and independently computes both that recorded historical lineage's service hash and the selected current global service hash. Both must match the stopped container's recorded/live config hash. A surviving unchanged service can retain an older scoped overlay rather than the latest one. Unknown path, altered file, reversed order or different historical/current effective config refuses. No recreation is required to manufacture one global lineage. It also checks Compose configuration labels,
source/image bindings, read-only evaluator and separate pgstream config mounts and absence of application
source mounts. A missing container, changed incarnation, changed config or an
unresponsive/live process refuses the operation. No recovery-owner test label is
part of this contract. Runtime application images must be the canonical immutable
image; nginx may use its separately pinned image.

The DBA query checks physical database/system/postmaster identity, no remaining
client or WAL-sender backends, the existing nonowner replication runtime role and
its current least grants, exact clock/settings/policy/activity/lifecycle plus DDL
subscriptions, and selected slot state. A valid slot is refused rather
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
# Reinspect exact identity/state/policy, then deliberate evaluator and pgstream start.
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

Next, use the same prepared Compose arguments and canonical image to explicitly
start **the evaluator and separate pgstream service**, with
`--no-deps --no-build --pull never`. Keep all other effect-serving roles stopped.
Do not use `demo.sh up`: that command starts other effects and performs
demonstration setup. The evaluator validates the actual source role, slot and
subscriptions at startup, then verifies and scans current tenant metadata and
commits bootstrap reconciliation. The application creates no synthetic heartbeat
row or periodic pulse. The platform owns the separate Go process lifecycle; an
idle silent feed has no application-level bounded detection claim. Its indexed pending/due work reconstructs clinical progress
without resetting persisted ages, versions, output revision, notification identity
or due clocks.

Before explicitly reopening other services, independently compare current physical
clinical/control clocks with observed/completed/input checkpoints and current
output identity, and verify retained overdue work completes without another
clinical write. Require no pending or named clinical refusal, current owner and
restore generation, and complete tenant coverage for this deployment. Future due
work remains scheduled at its real declared instant; it need not fire early.
Health alone is insufficient. Keep effects stopped on an incomplete oracle or
any refusal. Record the exact evaluator and pgstream start command and all old/new OS
incarnations in the operator evidence. Reopen the remaining cohort only through
its existing admission/restore protocols, with explicit operator disposition.

Full initial DBA setup is not a recovery alternative: it creates tables,
subscriptions and policies. Silent runtime slot recreation is not an
alternative either: it would skip the explicit stream-coverage/reconciliation
boundary. This operation preserves those boundaries instead of manufacturing
completion counters or extending product deadlines.

Plans and receipts contain only identity metadata, file paths/hashes and selected policy metadata. They contain no private environment, config document, URL or credential contents. Receipt container fields are selected explicitly rather than echoing an arbitrary raw Docker inspection.

## Current ordinary-profile rehearsal

The maintained [populated recovery drill](../../../operator/drills/README.md#populated-stream-coverage-recovery)
composes the stopped-slot operation with current ordinary-profile reconciliation
and authorized API/WebSocket convergence. It binds an explicit private effective
environment file when startup supplied the immutable image through the
environment. The helper sanitizes inherited Docker variables: an ambient image
pin alone is insufficient to reproduce the stopped cohort's Compose hashes.
Do not weaken the hash guard to accommodate a different effective Compose view.

Recovery obligations concern current durable work and clinical content. The typed
checkpoint can advance completion and the next due instant while retaining an
unchanged clinical body and revision. Requiring every recovery to increment a
revision, change an executor label, replace its body timestamp, or clear every
future due instant would reject supported deduplication and scheduling behavior.
Keep the independent physical/input/completed/authority checks and real deadline
progress before deliberate reopening.

### Captured ordinary-profile result — 2026-11-16

**Reproduced: PASS** on core
`db9fcc33bc36c3c800873bda7d9ad10c6daa322a`, prepared deployment
`9bb971c8704d2436e9a5ca1a3850511cc7b7cc6a`, application image
`sha256:859d96ecd3992f755565778b04157fff60d56a6c1e6ef3184e32f248ebea214e`.
The separately mounted operator drill SHA256 was
`d87048d3342b9ccc42ba60163a6e19d20801b30dc1a92ff1d5b5aa6e78627133`.
This result does not inherit earlier image qualification.

| Actual operation | Result |
|---|---|
| Populated API write during evaluator/stream stop | New clinical value remained uncompleted before recovery and matched physical, accepted and completed state afterward |
| Wrong physical database identity | `PGSTREAM_REBOOTSTRAP_BACKEND_CHANGED`; no slot created |
| Existing canonical slot helper | `SLOT_RECREATED_EFFECTS_STOPPED`; application cohort still stopped |
| Reconciliation before serving reopen | Both tenants current, no pending work, unchanged authority and restore generation |
| Original recent-SGV deadline | Durable completion crossed it; later genuine retention deadline preserved; neighbor's future deadline retained |
| Deliberate same-container restart | Recorded evaluator `on-failure:3` and pgstream `unless-stopped` policies restored |
| Current authorized viewers | Both API reads and WebSocket clinical frames matched their tenant's expected value through maintained ingress |

Retained evidence identifier: `operator-recovery-stream-20261116-final`.
Private original `pgstream-reconciled.json` SHA256:
`c9c1902334878d0d8ef9ac5df84f8e000eb69a1f35d5e9bfdc2edb1b2eb891a1`;
final command log SHA256:
`9b2217181d39d9ef6efa0b59977a5abfd44ff7900dbd0ece3c4b2658d5236607`.
Earlier fixture identity, environment-composition and overconstrained due-oracle
failures remain retained with their original attribution. They are not semantic
product failures or replacement passing runs. See the drill's scope and controls
for the unsupported upgrade/restore/authority-change cases.

Focused controls reproduced 30 wrapper/oracle checks and 31 installed-helper
checks. Removing pgstream from the wrapper's restart cohort made the wrapper
control fail; restoring it passed. The helper fixture now includes all six raw
clinical routes as well as metadata, so missing clinical subscriptions reach the
specific `PGSTREAM_REBOOTSTRAP_SUBSCRIPTIONS` refusal instead of being masked by
an earlier stale-wire fixture failure. The helper itself is unchanged.

After the deployed run, the oracle was strengthened to reject duplicate tenant
coverage and a dropped neighbor deadline. That validator, SHA256
`5a464a74018f6c1a31e44a6d618efff03acef0c4872cda62c7557c84cecb06ec`,
passed against the unchanged captured before/reconciled snapshots, with separate
broken/restored controls. It did not trigger another deployment campaign.
The owned containers, volumes, networks and published port were removed; private
originals remain retained. The host was shared with other independently owned
runs; this is functional recovery evidence, not a performance measurement.
