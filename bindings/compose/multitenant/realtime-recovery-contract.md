# Realtime recovery action boundary

Prospective source capability, not a selected profile or executable commissioning
path. These class-owned files do not install admission, start containers, construct
PG clients, publish a map or establish native lock/process/clinical proof. The
fixed RT entry, action planner and shared fixed-path host integration remain open.
Legacy/default dispatch and source selection are unchanged. Never dispatch RT via
a generic `C.close` path while this integration is incomplete.

## Version and preparation boundary

The class is `realtime-recovery`; caller intent is **exactly** version1 with
`command: inspect | reconcile-step`. Common ledger3/control2/gate2/receipt2 and
physical ticket2 remain unchanged. RT config/action/binding/claim/message/result
are separate version1 contracts. Only fresh physical plan2 + workerDatabase name
and string OID + map2/key2 + private realtime inspection3 are supported. No existing
profile conversion, old-credit reset or mixed-key downgrade exists.

`config.normalize(raw, internal)` validates and clones/freeze-seals:

```
{version:1, ownershipVersion:2, consumer,
 namespaces:{control,registry}, plan, roster, desired, policy,
 execution:{timeoutMs,readinessTimeoutMs,maxRegistryTenants}}
```

`plan` is the actual canonical common physical2 plan, including the declared RT
class principal and finite worker/overlap/control credits. `roster` is exactly the
approved `realtime-recovery-roster.prepare` output, with every fixed participant
and predeclared worker template/service/config/environment/socket. Desired workers
are a subset, not a substitute for complete current/idle/draining/physical-history
and independent SQL/tag census. `policy` is exactly version1/gracePeriodMs/limits;
limits are maxLogicalMoves/maxAssignmentChanges/maxAffectedTenants. Total execution
is at most900000ms; readiness is within that bound, registry census<=100000.

The dedicated private environment is exactly NS_SOURCE_COMMIT and
NS_REALTIME_RECOVERY_PG. `config.environment` checks source, actual pg parser DB and
explicit URI role/database against the declared class principal. Secret bytes are
read only after metadata ticket/gate/image/action proof. URI contents never enter
messages, journals, results or public diagnostics. The fixed entry must also
verify actual role+OID/database+OID/backend+epoch and readonly READ COMMITTED on its
single admitted backend; config metadata is no grant or SQL identity proof.

Required effective grants are lifecycle LOWER/window-reader + registry revision/
page enumerator + activity READER, derived from actual core screens. In particular:
USAGE(control), SELECT schema_migrations/tenant_lifecycle_windows/
tenant_lifecycle_operations; registry USAGE, schema_migrations and actual screened
revision/page functions; activity USAGE, schema_migrations and tenant_activity.
Do not reuse lifecycle-maintenance/audit-append authority: LOWER intentionally
refuses it. Preserve NOSUPER/NOBYPASS, owner/RLS/table/audit/function-version and
EXECUTE/grant checks. Host resource custody supplies systemIdentifier; class SQL
observes actual role/DB OIDs, PID/birth and postmaster epoch, not systemIdentifier.

## Three distinct digests and exact files

`action.normalize(value, context)` accepts the closed fields in that source, not
caller dispatch. Kind is inspect/no-op/self-restart/peer-takeover/roster-step. It
binds class lease/nonce, exact caller-intent digest, source/plan/resource epoch,
expected platform custody, desired/policy/inventory and config/environment digests,
raw backend/routes/candidate bytes, old physical bindings<=1, starts<=2 and limits.
Semantic action hash sorts object keys; raw action file hash additionally binds
serialization. `action.envelope` requires a privately branded normalized action.
Do not replace either digest with the hash of the common ticket file.

Ticket `control.files` is exactly these existing private inputs (at most8):
intent.json, action-binding.json, host-action.json, config.json, env.json,
before-map.json, before-routes.json; candidate-map.json only for publication.
Ticket/gate are additional fixed common view files. Worker and control ticket/
claim views remain separate; journal/ledger/Vault/sibling tickets never enter the
child writable placement view. Narrow placement RW contains only backend/routes
and source temporary publication files, not authority or arbitrary siblings.

`proof.metadata({ticketBytes,gateBytes,files}, action, binding)` takes every listed
input EXCEPT env.json. It requires a normalized action and actual common receiver
validation, exact file roster/digests, semantic action + binding and raw ticket/
gate bytes. Only after this proof may the fixed entry read the private env bytes;
`proof.environment(metadataProof, envBytes)` checks their raw digest.
`proof.claim(claimBytes, completeProof)` checks the exact exclusive RT claim, which
binds lease/nonce/plan/intent/action semantic+raw/binding/raw ticket/raw gate hashes.
No credential/constructor/auth effect precedes the fixed known-source/image/gate
and semantic metadata proof; no admission installation precedes exclusive claim.

## Durable host methods (under actual common controller lock)

- `journal.allocate(fd,plan,book,intent)` calls actual common C.allocate and returns
  its row plus a private process permit. The caller MUST save the resulting book
  under the SAME existing lock. It is not an extra allocator. A prior RT UNKNOWN
  refuses reconcile-step; a separately debited inspect can diagnose, not replay.
- `journal.publish(fd,permit,action,context)` consumes that permit. It checks exact
  saved ISSUED readback, fsyncs the actual saved ledger inode+directory itself, then
  exclusively fsyncs the one action-binding.json/host-action.json/phase.json under
  realtime-recovery-journal/<incarnation>. No caller boolean or save callback.
  Omitted/failed/reordered save, lost permit, another lock session or existing
  journal refuses. Partial files are retained with sticky uncertainty.
- `journal.authorizeStart(fd,dispatchPermit,plan,book,context)` consumes a separate
  private one-use permit, persists LAUNCH_AUTHORIZED and starts the process-local
  monotonic total deadline. It does not start a container. The fixed host then
  creates the exact common ticket, binds actual child custody and publishes gate.
  Process loss cannot reconstruct either permit or rederive the action.
- `journal.beginMessage(...)` validates current saved BOUND row, immutable binding,
  private current transcript hash/deadline and closed next request. It fsyncs the
  pending request BEFORE returning a one-use effect permit + sealed action/index.
  Host derives every command from that action; never from message arguments.
- `journal.acknowledge(fd,effectPermit,...,ack,evidence)` consumes the permit and fsyncs exact
  ack/result. Running requires exact `{execution,claimBytes}` raw proof; start-selected independently checks the saved common worker row AND the canonical slot ticket bytes. A process-loss pending request is not retryable. No common lock is
  held across the actual asynchronous host operation; reacquire for each method.
- `journal.close(...,{receiptBytes,execution,claimBytes,actual,observation})` checks
  current journal/transcript, actual ticket/gate/file/claim chain and fixed RT result
  BEFORE invoking generic C.close's real quiescence/resource/zero-own-tag checks.
  It then saves the common ledger. Missing/mismatch cannot be generic close success.
- `journal.uncertain(...,reason)` invalidates the process channel BEFORE fallible
  persistence, then charges UNKNOWN + class marker. Reasons are the fixed bounded
  HOST_FAILURE/MESSAGE_FAILURE/DEADLINE/RECEIPT_FAILURE enum. Never refund/redispatch.

The shared launcher must retain primary errors and persistence/cleanup errors,
keep every observer/control/worker debit, and prove actual child/group termination
and no-future-dispatch. It must supply fixed bounded file reads and hard monotonic
effect/process timeouts; journal checks cannot cancel external commands or replace
actual EOF/physical retirement. Never hold a controller lock across message waits.

## Closed messages, proofs and physical worker views

Every request is exactly version1/class/leaseIncarnation/nonce/intentSha256/
actionSha256/sequence/kind plus index ONLY for confirm-old/stop-old/start-selected.
Sequence1..16, request<=1024B, ack<=16384B, transcript<=131072B. Ack echoes the exact
request plus `result`. Source protocol validates/replays every event and pending
request. Reverting to an earlier syntactically valid phase is also refused by the
process-owned transcript hash. No shell/path/SQL/CID/service/raw-argument request.

| Kind | Required fixed result and ordering |
|---|---|
| running | BOUND + raw ticket/gate/claim hashes, first only; host reads actual exclusive claim |
| confirm-old(index0) | RUNNING/STOPPED + noFutureDispatch iff STOPPED + retained observation hash; at most2 actual fresh observations |
| stop-old(index0) | STOPPED/noFutureDispatch/observation hash; roster-step only after actual RUNNING; not forced termination as clean-credit proof |
| restart-cleared | RELEASED + stable map digest + proof hash, self-restart only after stopped proof AND actual old-key transaction release |
| assignment-published | MATCHED + exact candidate generation/digest/raw bytes, publication only after exact old exclusion/actual held old key |
| start-selected(index<=1) | STARTED + fresh CID/birth/source/service, fresh worker admission incarnation/nonce/ticket hash and exact config/effective env hashes; after restart-cleared or assignment-published |
| warm-complete | READY + fixed private readiness-witness hash, after all starts and actual eligible/readiness checks |
| routes-published | MATCHED + exact candidate generation/digest/raw bytes after warm; old-key publication transaction still held |

RUNNING is never STOPPED; health/charged credit is not exclusion or lock proof.
The fixed child must compute actual lower/registry/activity/lock readiness, not echo
these labels. Pause/suspend skips ACTIVE warm requirement; unknown state refuses.
Fresh registry revision per pass, exact target process/assignment/map, selected
inspection3 batches<=128 with actual configured byte/deadline bounds are mandatory.
Cached inspection is observation, never actual owner-lock or freshness authority.

For starts, action includes prepared config/environment digests AND
`effectiveEnvironmentSha256`. `worker-view.derive` reads exact prepared bytes and
changes ONLY REALTIME_WORKER_INCARNATION. It keeps worker/socket/source/credentials
and all other fields exact, rejects loader/admission env injection and currently
supports the declared UDS worker profile only. Host exclusively writes/mounts that
new private env view: service-environment.apply otherwise overrides Docker -e with
old env.json. Separate common worker allocator supplies fresh ticket/claim/boot;
never restart the old one-use container/ticket. No hidden slot or credit reset.

Same-assignment restart preserves assignment/key/map generation, releases its
checked old-key transaction BEFORE boot reacquires that SAME key, and bounds full
assigned warm work. Publication retains actual OLD assignment key on the SAME
admitted READ COMMITTED readonly client through new-key boot/warm/routes/COMMIT.
Retained-shard warm work is reported separately from logical moves. Uncertain map
publication stays blocked, not rolled back/replayed from an inferred checkpoint.

## Result and remaining integration

Receipt result is exactly version1/actionSha256/bindingSha256/transcriptSha256/
raw ticket/gate/claim hashes/status/error/work. Status matches common outcome.
REFUSED is allowed only before effect milestones (running/confirm-old); after a
stop/start/publication/pending/late outcome use UNKNOWN. Completed mutation work is
exact bounded generation/digest/affectedTenants/logicalMoves/assignmentChanges/
logicalMovedTenants/retainedWarmTenantUpperBound/warmWorkBasis. Inspect/no-op work
is null. There is no raw tenant payload, credential or caller lock assertion.

These primitives do NOT yet implement the fixed executable RT entry, host planner,
actual grace/process/census provider, one-client nonpublication restart check,
private readiness loop or fixed attached IPC dispatcher. Shared host files remain
owned by the common owner. The future entry/host must prove all named operations
against actual core/source before this is a complete source capability. Actual PG
MVCC/grants/locks/epoch, container exclusion/restarts, finite physical credits,
alarm handoff and B continuity remain separate required native proof.
