# Opt-in controlled PostgreSQL admission candidate

This is a source candidate, not capacity or native acceptance. The default
Compose path is unchanged. The selected profile accounts for every reviewed
constructor in the expanded registry API/realtime/evaluator/admin/feed/UI roster.
New source, unknown capabilities, undeclared workers or operator SQL paths refuse.
The exact reviewed core is `connection-budget.js:REVIEWED_CORE_COMMIT`; changing
that pin requires constructor/factory, configuration, shutdown and consumer review.

The library keeps three different facts separate:

* Source inventory and evaluated configuration describe requested pool sizes,
  simultaneous instances, direct-client groups and lifetime sessions already
  within a physical pool. Lazy creation never makes a declared cost zero.
* A private explicit profile selects finite limits and unmanaged, observer,
  control/recovery, bootstrap and old/new overlap allowances. Aggregate process
  maxima plus these allowances and PostgreSQL reserved slots must fit.
* Bootstrap binds actual PostgreSQL system identity, postmaster epoch and settings.
  The controller rechecks them before every controlled start/retirement. Source
  arithmetic is not a measured backend count or a physical capacity recommendation.

## Profile and preparation

Use a clean prepared core/deployment source tree. `node
 deploy/multitenant/connection-budget-profile.js inventory` admits source/overlay
identity before evaluating the pure configuration graph, and emits no credentials.
The existing replica, realtime, evaluator and operation-lease selectors determine
that expanded graph. The output is inventory, never a launch authorization.

A private owner-readable-only profile has:

```
version: 1
kind: explicit-connection-budget-profile
source: { coreCommit, deployCommit }
resource:
  pgResourceId, systemIdentifier, postmasterStartedAt, serverMaximum
  reserved: { superuser, other }
  aliases: [ canonical-host:port ]
  allowances: { unmanaged, observers, controlRecovery,
                bootstrapOverlap, oldNewRolloutOverlap }
slots: [ { processInstanceId, capabilities, directGroups, cold,
           maximumOutstandingGenerations } ]
bootstrapSchedule: EXPLICIT_OVERLAP
```

Each inventory capability must appear exactly once. Pool entries contain
`kind: pool`, explicit `poolMax` and `maxInstances`; direct entries contain
`kind: client` and a declared concurrency group. The group costs once across its
members; persistent listeners/readers require their own group. EVAL settings
requires one retained pool and at least four shared settings/catalogue direct
slots. Lifetime sessions must fit their selected pool. The selected constructor
quota can refuse exhaustion, including DATA retries with unconfirmed cleanup;
it does not silently change the DATA cleanup implementation or release its credit.

Cold configuration contains positive bounded `activeLimit`, `pendingLimit`,
`minDelayMs` and `maxDelayMs`; capacity must cover source startup producers.
FIFO orders admission slots. Concurrent jitter can reorder actual work starts.
Only the selected profile adds queued health fields; existing readiness and
per-read authority/schema/privilege checks remain in force.

`serverMaximum: DERIVE_DECLARED` explicitly selects deployment sizing from the
complete declared aggregate plus reserved slots and headroom. A numeric maximum
is instead checked for overcommit. This follows the maintainer's PostgreSQL
connection-budget decision; it supplies no memory/throughput or production sizing
claim. `OBSERVE_AT_BOOTSTRAP` for both server identity fields requests one-time
binding to the fresh actual target; all numeric settings must still match exactly.
At least two observer slots, positive control/recovery reserve and two permanently
held bootstrap overlap slots are required. No existing baseline is resized.

`demo.sh prepare --connection-budget /absolute/private/profile.json` validates
source/configuration before generating the selected overlay. It records digests
of every Compose input and `.env`. Derived sizing adds the corresponding explicit
PostgreSQL command only to that selected overlay. Bootstrap creates the final
private plan and per-process claim directories, without any worker ticket.

## Selected PostgreSQL health boundary

The selected overlay replaces periodic `pg_isready` connections with a fixed,
read-only-mounted POSIX helper, labeled LOCAL_POSTMASTER_DECLARED_READY. It reads
PostgreSQL's own ready marker and the current PID1 executable/process birth;
it rejects starting/stopping, stale/wrong PID, temporary initialization server,
paused/zombie state, recovery/standby, partial/changing records and wrong target.
It opens no PostgreSQL connection. This is a local postmaster declaration, not
live TCP, SQL, privilege or capacity health. Bootstrap and every worker admission
still require finite actual SQL settings/identity/epoch validation.

This Linux helper is source-bounded to the exact PostgreSQL16.15 image currently
pinned in Compose. A single no-network, read-only, no-PostgreSQL-startup tool probe
confirmed its shell/stat/awk/getconf/readlink/wc/cat/date and CLK_TCK support;
no persistent Docker volume was created. PG source-tar SHA256 is
`c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed`.
The algorithm follows [pg_ctl's ready-file contract](https://www.postgresql.org/docs/16/app-pg-ctl.html)
and the [16.15 PID-file format](https://github.com/postgres/postgres/blob/REL_16_15/src/include/utils/pidfile.h),
with stricter primary/standby rejection. Seconds-resolution timestamp sanity is
not a substitute for exact Docker incarnation and actual SQL postmaster-epoch
custody. No matching running-server or capacity result follows from the tool probe.

The selected health command invokes the pinned image's fixed `/usr/local/bin/gosu
postgres /bin/sh` before the helper. The image defaults to root, which cannot read
another UID's `/proc/1/exe` under its default capabilities; the actual isolated
platform control reproduced root refusal and postgres-user success. No capability
is added and the executable/process-epoch checks remain intact. The same platform
control measured numeric self birth, a matching live OS process and normal backend
exit; full application runtime acceptance remains unmeasured.

## Explicit instance preparation and image identity

`prepare.js --project <name> --backend-subnet <CIDR> --edge-subnet <CIDR>` selects
an instance before any state or custody is created. Project names use the same
bounded lowercase identifier contract as controller custody. The optional subnet
pair must be canonical, wholly RFC1918 and disjoint. They enter the existing
replica overlay before its digest is recorded. Omitted options retain the legacy
project and Docker network allocation. Source validation does not prove that
ports or ranges are free: the episode owner must freshly inspect Docker networks,
listener ports, routing and roster address capacity before allocation. Ambient
Compose project variables do not override prepared identity. Every shipped
lifecycle/build/controller path supplies the prepared project explicitly.

The image builder supplies validated core and deployment build arguments. The
Dockerfile writes fixed public `.image-source.json` metadata, mode0444, in the
final root stage. Selected installation compares its exact pins/schema before
claiming a ticket; missing, null, stale or mismatching metadata refuses. The host
`.overlay.json` is preparation metadata, not an image file. Unselected direct
builds may carry null pins and cannot enter selected admission. Saved-image
qualification must inspect this generated file separately from Git-tracked files.

Operational health reads only the existing private listener/admin/operation
metadata through a bounded reader. It neither copies database environment values
nor installs admission or claims tickets. Actual role entrypoints and Node
preloads still apply the full validated environment and unconditionally install
selected admission once. Private NODE_OPTIONS/NODE_PATH/preload overrides remain
forbidden. Docker health inherits container Config.Env, not the running server's
mutated environment: the reviewed Compose commands contain no Node preload for
health, and qualified image environment contains no preload override. The actual
native episode must verify these selected container commands/environment too.

## Controlled lifecycle

After the normal explicit bootstrap completes, use:

```
./demo.sh admission bind
./demo.sh admission start api
./demo.sh admission stop api
./demo.sh admission observe
```

Repeat `start` for each declared process, preserving application provisioning and
API/realtime/evaluator dependencies. Primer provisioning and evaluator membership
initialization remain ordinary HTTP clients of admitted services. This is not an
all-services orchestrator or an instruction to skip those existing prerequisites.
Ordinary selected `up`, restore/demo, commissioning and placement-operator SQL
routes refuse. Additional operator/CLI overlap requires its own reviewed finite
source declaration; it is never charged to an assumed spare slot. Non-PG edge
startup remains separate and must not implicitly start unadmitted PG workers.

The controller uses one held private lock, fixed local Docker commands, prepared
file digests, immutable selected image ID, image-source labels and exact project,
working directory, service, CID and StartedAt custody. Prepared image/bundle
provenance must be qualified separately; labels alone do not certify a build.
Credit is durable before the ticket and before the process effect. A failed effect
retains its complete generation credit. Each ticket is one use, and each process
gets only its own ticket and writable claim directory. No per-query SQL or disk
admission hop is introduced.

Normal stop freezes constructors/handshakes and cold producers, drains services,
then requires positively completed authentication, idle protocol Terminate,
observed peer EOF, clean transport close and every connect/end outcome settled.
Pool.end or locally destroyed Connection.end alone is insufficient. An aborted
preauthentication backend can be invisible to pg_stat_activity; an empty tag
census never refunds that uncertainty. Active/unqueryable end, raw local destroy,
transport errors and unknown stream replacement retain direct and pool credit.
The selected proof currently supports the reviewed plain isolated PG transport;
selected TLS refuses explicitly, with no plaintext fallback. The unselected TLS
and DATA implementations are unchanged. PostgreSQL's [16.15 peer-close ordering](https://github.com/postgres/postgres/blob/REL_16_15/src/backend/libpq/pqcomm.c)
places normal socket/process closure after shared cleanup; local abort is a
different event. Only successful shutdown publishes an atomic
private nonce/source/incarnation ACK, including lossless original application-name
mapping and the complete expected bounded incarnation tag set. The controller
also requires the original exact container stopped with body exit zero, no OOM
or runtime error, and fresh absence of every
old tag on the same server epoch before retiring credit. A forced stop, stale ACK,
late backend, missing tag or uncertain cleanup never refunds credit. Explicit
finite overlap can cover uncertain generations; exhaustion refuses. Stale locks
and uncertain observer markers require operator investigation, not timed deletion.

The fixed metadata observer has finite durable reservations too. Each authenticated
observer records a private nonce application name, backend birth, PID and numeric
Linux process birth. A later bounded no-SQL probe in the exact pinned PG container
must positively find its process absent before credit reuse. A present process
retains credit even if its SQL activity row disappeared; PID reuse, legacy missing
birth metadata and probe errors refuse. PG16 [pgstat shutdown](https://github.com/postgres/postgres/blob/REL_16_15/src/backend/utils/activity/backend_status.c)
precedes [ProcKill cleanup](https://github.com/postgres/postgres/blob/REL_16_15/src/backend/storage/lmgr/proc.c)
under the [reverse shutdown callbacks](https://github.com/postgres/postgres/blob/REL_16_15/src/backend/storage/ipc/ipc.c);
[libpq close](https://github.com/postgres/postgres/blob/REL_16_15/src/interfaces/libpq/fe-connect.c)
is local. Neither SQL absence nor psql exit proves physical retirement. The same
fixed metadata query reads at most 4096 bytes of its own process stat and returns
only numeric birth metadata, never the raw file. Known observer census exemptions
match PID, backend birth and nonce name together.

A timeout/unknown command outcome retains its observer reservation and blocks
repeated attempts. Unknown clients must fit only the explicit unmanaged allowance,
never borrow unused bootstrap/control reserve. Preauthentication is invisible to
this census. SQL has connect/statement/output bounds, with no tenant data or URI
persistence. The explicit `observe` command holds the same controller lock and
reservation before SQL, returns the atomic private ledger plus authenticated-only
census and host monotonic request brackets. It never starts or stops a worker,
retries, frees uncertain worker credits, or certifies process liveness.

## Qualification boundary

Focused pure/source controls cover aggregate/roster/coverage/headroom/lifetime,
source refusal, whole cold work/context/drain, actual pg-pool early-end behavior,
private publication, generation/observer retention, stale/forged ACKs and selected
CLI refusal. They do not establish runtime capacity or a chosen production
profile. The existing shipping measurement selector intentionally rejects this
new overlay until its coordinator integrates a separately identified instrument.
Tagged diagnostics must use the private mapping, not the old application-name
filters. Preserve original application/instrument evidence.

Before acceptance: freeze the joined core/deployment/image and actual bundle;
qualify fixed Docker custody, actual SHOW/settings and physical census; then one
matched simultaneous start/full restart, role restart with healthy tenant B,
scaling/drain/resume, delayed-auth/uncertain cleanup and negative-control campaign.
Retain isolation, RLS/authority, stored-count, reconnect, alarm and TIME checks.
Warm-up/recovery durations are measured outputs, not invented capacity SLOs.
Full/browser/clinical acceptance and final prcheck belong to the coherent joined
candidate, not this leaf. No runtime or remote result is claimed here.

## Native synthetic stored-count observation

The opt-in controller command reads one private selector file:

```sh
node deploy/multitenant/connection-budget-cli.js "$STATE" stored-counts "$SELECTOR"
```

The selector has exactly `version: 1`, `kind: native-synthetic-stored-counts`,
`runId` matching `^m7-native-[a-f0-9]{16,32}$`, and `tenants`: one to 128
unique canonical lower-case UUIDs. It accepts no SQL, schema, table, role or
module options. The selector file uses the controller's existing private-file
ownership, mode, size and symlink checks.

The fixed `nsdemo` layout supplies `nsdemo_entries.entries`,
`nsdemo_devicestatus.devicestatus` and `nsdemo_treatments.treatments`.
One bounded SQL statement combines resource metadata and counts. Requested rows
retain selector order, including zero rows. Each contains `tenant`, `entriesTotal`,
`entries`, `devicestatus`, `treatments` and `probe`. Marked entries and devicestatus
match `doc.device = runId`; treatments match `doc.enteredBy = runId`; probe entries
match `doc.device = runId + '-probe'`. `entriesTotal` counts all entries for that
tenant. Counts are nonnegative safe integers; marked and probe entries together
cannot exceed the total. No documents or document identifiers are returned.

`foreign` contains the same four marker counts across tenants outside the requested
roster, without returning their identifiers. Positive foreign counts remain visible
observations. The native episode must compare expected counts and require all
foreign totals zero; this command makes no acceptance decision.

The envelope includes the canonical selector and SHA256, exact source and plan hash,
expected source/image/project/workdir, PostgreSQL CID/birth/image custody, resource
metadata and host monotonic request brackets. Its scope is
`FIXED_SYNTHETIC_COUNTS_ONLY_NOT_NATIVE_ACCEPTANCE`. The same controller lock,
outer durable claim and adapter `observers.json` apply to bind, observe and counts.
Counts requires the selected total observer allowance to be exactly two; it uses
no control, recovery or spare connection. Existing query, connection, statement,
output and time bounds apply. Unknown outcomes retain credits until the existing
OS PID/birth retirement proof permits reuse.

After SQL returns, a private immutable `counts-observation-<nonce>.json` retains
safe unvalidated foreign totals before result/resource validation. Refusals name
that diagnostic when written. If that write fails, structured stderr retains the
safe foreign totals and selector hash with `UNVALIDATED_DIAGNOSTIC_NOT_ACCEPTANCE`;
it does not refund either credit or retry. Raw output belongs in the private run
workspace. Recording controls exercise these paths without executing SQL. Actual
PostgreSQL syntax/count semantics and native episode outcomes remain UNMEASURED
until the coordinator authorizes the separate runtime proof.

## Private mounted inputs

The selected bootstrap reads its profile from a read-only mount of the existing
private connection-budget directory. Bootstrap already has the state directory;
this mount preserves the required private parent ownership and mode. A file-only
mount creates an untrusted parent inside Docker and is refused by the unchanged
private reader.

Workers receive a separate read-only `plan-view` directory with only `plan.json`,
not the controller directory or sibling process tickets and claims. Bootstrap
publishes an independent private copy of the canonical plan, with a single-link
file and private parent. Before a worker Docker effect, the fixed adapter reads
the copy through the private reader and requires equality with its admitted plan.
Missing, changed or unsafe copies refuse startup. Runtime plan/ticket validation
remains mandatory before constructors. This changes selected mount preparation,
not connection allowances or default startup.

### Fixed lifecycle operator (source implementation)

Fresh preparation can select `--lifecycle-operator enabled` together with the
explicit connection-budget profile. Bootstrap binds the private operator
role/database object identities, tenant locks and configuration hashes into the plan and creates a
version 2 ledger. Existing version 1 runs refuse the lifecycle command; a missing
version 2 ledger refuses rather than reconstructing unused credits.

After a reviewed compatible source/image/plan selection, the fixed CLI command is
`node deploy/multitenant/connection-budget-cli.js <state> lifecycle-operator <private-intent-file>`.
The intent contains only `version: 1`, `command` (`inspect` or `resume`), and the configured `tenant` UUID. `resume` additionally
requires the exact inspected `claimId`. Keep the intent in a private directory
with mode 0700 and the file with mode 0600.

One invocation durably consumes one reserved `controlRecovery` credit before
publishing a ticket or starting a child. Only one unresolved control lease is
permitted. The host binds the exact child before opening its authentication gate.
The child receives only its private operator environment/configuration, selected
placement, ticket and writable claim/receipt directory. It uses core admission
and one backend; it cannot acquire a replacement connection.

`inspect` performs diagnostic reads without contacting participants. A resume checks current operator authority, durable restore ownership and the
exclusive tenant lock. It appends a resume audit row and activates the inspected generation.
A 30-second lease fences every new SQL dispatch, including COMMIT. A late reply,
uncertain commit, lost authentication or unproven close retains `UNKNOWN` and
blocks further invocations. Late evidence never automatically clears `UNKNOWN`.

`CLOSED` requires core's Terminate/peer-EOF/clean-close quiescence, the exact
cleanly stopped child, and an independently charged same-epoch observer finding
zero rows for the exact durable tag. Empty census or forced stop alone cannot
retire credit. Observations distinguish worker and control physical occupancy;
known control tags come only from durable outstanding leases.

This source change does not change the reviewed-source literal, source/image
pins or current runtime. Native three-command acceptance is UNMEASURED. The
existing raw-Pool export/restore demo remains unplanned; it cannot establish
coverage for these commands or set up an admitted interrupted-restore drill.
