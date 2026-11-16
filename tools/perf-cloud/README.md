# Bounded performance experiments

The common experiment specification runs finite synthetic cells through the
existing pgstream caller and worker. The controller owns each independent pair's
transport, collection and exact deletion. The root owner supplies reviewed
authority, provider inventory, the budget ledger and independent cleanup guards.
Source checks qualify the tooling; actual paid batch execution remains UNMEASURED.

## Finite independent-pair experiment batches

`pgstream-caller.mjs batch-plan batch.json /absolute/payload-root` validates and
prints one reviewable batch. It starts no transport or provider action. The batch
uses version 1, an `id`, `payload`, `envelope` and explicit `cells`. The common
runner and this controller use the same field names. Each cell retains its
existing single-point spec in `config`; its normal source, receipt, workload,
SSH identity, firewall and lifecycle checks still apply.

`payload` pins `source: {core, deploy}`, `image`, the extension digest as `helper`,
and `files: [{path, sha256}]`. The exact transport allowlist is every
`sourceFiles('sut')` filename under each cell's ID directory. No absolute paths,
extra exports, symlinks or changed bytes are admitted. Transported spec, receipt,
binding and manifest are checked against the declared cell. Create each bundle
with the existing `bundle` command, then hash its actual files into the batch.

The envelope declares positive integral `maxConcurrent`, `maxLiveResources`,
`maxOfferedRps`, `millicpus`, `memoryBytes`, `heapMiB`, `hourlyMicrousd`,
`totalMicrousd`, an absolute UTC epoch `cleanupAt`, and `workload` bounds. Workload
bounds are inclusive `[minimum, maximum]` pairs for `tenants`, `offeredRps`,
`durationSeconds`, `probeEveryMs` and `hotFactor`; `faultCases` lists permitted
supported component cases. Existing component-case validation remains authoritative.
Changing cell counts or workload values inside an authoritative approved envelope
requires fresh integrity/plan validation and normal tool review, without a new
human workload decision. The root hook must bind that approved envelope; these
new hook actions have not been qualified against a real provider ledger.
A zero or missing observation is never synthesized from a failed cell.

Each cell declares unique `id`, `namespace`, `ports`, `/24` `subnets`,
`offeredRps`, `workSeconds`, `cleanupSeconds`, and `resources` with all six
resource fields above plus `liveResources`. Remote work and cleanup durations
bound the existing paidT0/lastNewPointAt/expiresAt clock; they never reset it.
Its `target` declares `kind: "remote"`, `provider`, `region`, `size`,
`namePrefix`, and `maxResources: 2`. Both inventoried hosts carry matching
provider/region/size/name metadata and positive integral `hourlyMicrousd` price
bounds. Exact provider IDs, nonces, cloud IDs, private/public addresses and
transport bytes remain pinned. Host addresses and application port must belong
to the cell's declared subnet and port scope.

This first batch capability schedules **already inventoried independent pairs**.
Every paid pair, including a pending pair, counts against the aggregate live,
CPU, memory and hourly envelope. The full sum of cell cost ceilings must fit the
total ceiling. Concurrency, heap and offered rate bound active execution. There
is no new allocation API or rig reuse: each entered campaign keeps its normal
collection, down and exact provider deletion. Future allocate-on-slot operation
requires an explicit root allocation/inventory-binding capability.

`batch-run` takes `{batch, providerHook: {path, sha256}}` and requires
`PGCAL_EXECUTE` equal to the batch ID. The existing reviewed executable provider
hook must implement `admit-batch` (return `ADMITTED`, the exact `planSha256`, and `cleanupGuard`),
`reserve-cell` (return `RESERVED` and an exact opaque token), and `release-cell`
(return `RELEASED` only for that token and exact deleted provider IDs), alongside
existing `admit` and `delete`. The root hook owns atomic cross-batch ledger
admission. Its `cleanupGuard` must report `ARMED`, an authority SHA256, a
`cleanupAt` no later than the batch cutoff, and every exact provider ID. That
independent root guard owns pending pairs during cancellation, interruption or
controller failure; the scheduler does not claim those allocations are absent.
The controller never substitutes its local counters for that ledger
or for actual tool review. Unsupported hook actions refuse; existing single-point
hooks and the default `run` command are unchanged.

### Trusted root-hook installation boundary

`pgstream-root-install.mjs` wires the existing root operations to `rootAdapter`.
The owning host supplies an immutable approval-request lookup and an original-user-
message reader. The lookup binds the concrete intent hash to the existing question,
question identifier, accepted answer text and source chat/message references.
The reader returns the original connected-tool response; agent relays, changed
questions, other chats and declined answers refuse. Controller JSON supplies none
of these authority fields. Existing question replies and explicit free-text replies
retain their format. A single-point approval cannot become batch authority.

The root's `boundBatch` port reads actual inventory and configuration. The module
derives the canonical projection and full cell hashes itself. Its other ports reuse
the existing preallocation guard, source/host observation, independent absence,
cleanup request and `admit`/`delete` operations. `dispatch` exposes only the existing
five hook actions; host-side `prepare` methods surround the existing allocator.
The source test composes the full lifecycle with an inert provider and ledger.

There is **no installed native original-message reader in this repository**. The
current private native hook trusts the owning chat's earlier direct read and checks
its sealed plan/GO records. `installRootHook` requires the trusted host ports and
refuses when any is absent; it creates no executable, authority file or key. Actual
native host wiring and live batch operation remain **UNMEASURED**. The host must
provide the connected-message bridge and existing provider/custody functions before
using this module in the reviewed hook. Source fixtures do not supply that authority.

The scheduler reserves whole cells synchronously before awaiting execution and
uses an exclusive retained batch lock. It never steals a stale lock or reuses an
old batch directory. Cancellation stops new cells; entered finite campaigns keep
cleanup custody. Unconfirmed reservation/deletion/release stops admission and
retains custody for reconciliation. One failed cell with confirmed deletion
leaves valid peer observations intact. `batch-result.json` records individual
status, retained result, cleanup and failures; no batch grants capacity acceptance.

Focused synthetic checks:

```bash
node --test tools/perf-cloud/pgstream-batch.test.mjs \
  tools/perf-cloud/pgstream-caller.test.mjs \
  tools/perf-cloud/pgstream-calibration.test.mjs \
  tools/perf-cloud/component-cases.test.mjs
```

These prove planning/scheduling and existing campaign compatibility through local
injected executors. They make no paid execution or provider-ledger qualification
claim. Optional observations remain separate from essential correctness checks.

## Explicit external pgstream transport

An external-service discovery spec declares both `pgstreamTopology:
"external-service-v1"` and `diagnosticResourceProfile:
"local-diagnostic-external-pgstream-4cpu-8g-v1"`. Its receipt carries exactly
matching `remotePgstreamTopology` and `remoteDiagnosticResourceProfile`. The
caller binding and worker CLI carry both selectors; helper prepare/load refuse
missing or changed selections. Omitting the new fields retains the existing
colocated defaults.

`helperDependencies` has `{version: 1, profile, files}` and is copied exactly into
`receipt.remoteHelperDependencies` and the runtime binding. Profile
`external-service-v1` requires exact hashes for
`tools/mt-bench/m7-joined/stream_topology.py` and `diagnostic_resources.py`.
Profile `external-service-batch-v1` additionally requires `experiment_batch.py`;
it is accepted only when the selected `diagnostic_resources.py` actually imports
that module. The remote extension allowlist remains its existing thirteen files.
These shared modules are included by the existing m7 source-pack scope, hashed
before export and checked again by helper admission before preparation/ingress.
A helper without the batch import does not inherit that dependency.

The existing canonical source/image qualification schema remains supported. The
new intermediate build schema
`CANONICAL_INTERMEDIATE_BUILD_LABEL_CHECK_AND_BUILDER_ABSENCE_PASS` is admitted
only for explicit external-service discovery with exact source/deploy/image,
build success, empty label mismatches, absent builder/source process receipts,
`runtime: "NOT_RUN"`, and `capacityAcceptance: "NOT_GRANTED"`. Its
`sourceQualification` also supplies `check: {path, sha256}` for the separate
canonical image check record, whose return code and tuple must match. These
actual records retain their schema; no old acceptance receipt is synthesized.
Image qualification permits source-only preparation and grants no runtime or
capacity acceptance.

The optional real-source tests take `PGCAL_TOPOLOGY_HELPER` plus exact
`PGCAL_INTERMEDIATE_QUALIFICATION` and `PGCAL_INTERMEDIATE_CHECK` paths. The paired
helper suite takes `REMOTE_PGSTREAM_CONTROLLER_ROOT`; without those inputs the
corresponding tests report skips. Source selector controls and local pipe framing
checks use synthetic data only. Typed batch component cases bind `faultCases` to
supported `kind` values (`rest`, `evrt`) and retain existing case validation; this
selector does not invent outage or recovery support.

Future remote sessions retain a separate `sut-session-events.jsonl` or
`driver-session-events.jsonl` beside the existing raw stderr log. The finite
metadata stream records phase, fixed event/error kinds, byte lengths, sequence,
buffer/queue sizes and close code. It records no payload, nonce, run ID, token or
raw stdout. An optional metadata failure does not change protocol admission.
Existing finite message/deadline limits remain unchanged. These records locate
future initiating parse/close failures; they do not retrospectively diagnose a
captured session without those observations. Batch plan cells also expose a
canonical `cellSha256`; root admission can compare the full reservation request
with that exact cell through the exported `batchDigest` utility.

The root worker assigns `generator-result-manifest.json` to runtime UID/GID
1000 with mode 0600, matching the imported artifacts. It creates that receipt
exclusively without following symlinks, then writes and assigns ownership/mode
through the same open descriptor. Existing files and dangling symlinks refuse.
This permits the runtime
summary to hash the exact import receipt without making it publicly readable.
The focused archive suite asserts exact receipt custody and private mode; its
additional real root-to-UID1000 read test reports SKIP when not run as root.

## Root reservation adapter

`pgstream-batch-root.mjs` adapts the existing reviewed root primitives; it does
not allocate a provider resource or load approval from controller input. Its
header specifies the trusted authority and custody gateway contracts.

Call `reserveBeforeAllocation` before the existing provider's create path, then
`markCreateAttempt` once. Bind independently observed IDs, SSH/NIC/source identity,
keys and exact guard birth with `bindAllocation`. The controller's three dispatch
operations claim those reservations without charging them twice. Attempted or
uncertain creates keep their conservative hourly/total upper until independent
absence; attempted total cost remains retained after cleanup. Cancellation stops
new claims and asks the existing owner to clean each exact cell.

`fileLedger` requires an explicit ledger path. It uses a real process flock,
compare-and-swap and fsynced atomic replacement. No real ledger, authority file,
provider credential, key or cleanup gateway is configured by default. Synthetic
fixtures cannot grant production authority. Install the trusted gateways through
the existing root owner and review a concrete batch before effects; no earlier
single-point approval is inherited.

The source-only tests use temporary ledgers, injected provider/custody gateways
and deliberate broken/restored controls. The root-to-UID1000 manifest reader
test is present but requires a root test process; it is skipped on the current
non-root workstation. Descriptor ownership, restrictive mode and symlink refusal
controls run without root. Runtime/provider qualification remains a separate
owned boundary.
