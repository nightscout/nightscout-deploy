# Fresh common control recovery contract

SOURCE CANDIDATE FOR INDEPENDENT REVIEW. Full runtime integration is open. This file
freezes the common boundary before collector or realtime bindings consume it.
It grants no executable source, image, resource or native-plan selection.

## Versions and fixed classes

Fresh profile2 compiles plan2 with `lifecycleOperator.version=2` and creates
ledger3 exclusively. Legacy physical admission tickets remain core version1.
Fresh host plan2 is distinct from the core physical admission ticket/plan2 contract.
Fresh ticket2 adds exactly `workerDatabase:{database,databaseOid}` at its top level.
Database uses the existing lowercase identifier grammar; databaseOid is a canonical
decimal STRING in 1..4294967295, no number, zero or leading zeros. Approved core
ab95fbb9f3b60f6de21f570477a23f19526c850f implements the fixed 1000ms same-admitted-
backend identity gate before Promise/callback/connect-event/public-query exposure;
no generic callback or extra backend. Companion generation and worker runtime now
carry and compare the exact cloned tuple before one-use claim/core admission.
The physical2 receiver requires primitive authority strings, exact non-array
ticket/control/gate objects and bounded integer fields before claims, credential
reads in the fixed entry, admission install or PG constructors. Serialized array
identities are refused rather than coerced. Legacy1 retains its valid schema.
Fixed class ticket construction uses the same physical2 fields. The lifecycle
entry supports that tuple for inspect/resume/clear-operations; capture/restore
explicitly refuse before admission until their artifact runtime joins. Fresh
controller/bootstrap dispatch remains HELD. Source fixtures exercise approved
ab95 APIs with synthetic source metadata. The selected d003 source/image pair is
unchanged and is not a runnable fresh2 selection. Lifecycle and commissioning typed action intents,
completion receipts and observation/stored-count envelopes use version2. The separately versioned
realtime caller intent is exactly version1 under the fresh class capability2. No
existing ledger is upgraded, recreated or reset. Mixed tuples refuse before
credential, ticket, process or authentication effects.

The fixed internal classes are `lifecycle-operator`, `restore-commissioner` and
`realtime-recovery`. The class string is also its processInstanceId, Compose
service and sole admission capability key. Every capability is exactly
`{kind:'pool',poolMax:1,maxInstances:1,metadata:{requestedMaximum:1,
source:<fixed entry source>,configurationSource:'fixed-controller-control'}}`.
Entry sources respectively are `deploy/multitenant/lifecycle-operator-entry.js`,
`deploy/multitenant/restore-commissioner-entry.js` and
`deploy/multitenant/realtime-recovery-entry.js`. This is a closed set, not an
extension registry. No caller selects a module, SQL, principal, path or exemption.
The exact realtime caller intent is `{version:1,command:'inspect'}` or
`{version:1,command:'reconcile-step'}` with no additional fields, per the owner
interface INTERFACE-realtime-recovery-control-2026-11-13.md. Host action, worker,
map, grace, target and proof fields are never caller intent fields. An uncertain
publication journal prohibits reconcile-step or other mutation/redispatch; only
a separately debited fixed inspect may run after exact predecessor stop proof.
Result completion never closes the common physical credit. The realtime lane
owns journal enforcement and action implementation after contract review.

Plan2 contains `controlRecovery:{version:1,classes:{<each fixed class>:{principal}}}`.
Fresh host plan2 additionally contains exactly `workerDatabase:{database,databaseOid}`,
measured by the EXISTING admitted bootstrap admin backend and sealed only after
every expanded worker environment PostgreSQL URL's effective database equals it.
Parsing uses the installed pg driver's actual ConnectionParameters, including
query semantics, encoded path and ambient/user defaults, with no Client/Pool/login.
Every fixed class principal equals BOTH this worker database name and OID; matching
classes only to each other is insufficient. URL equality is not actual backend
OID proof. Each class's existing singlePool verifier checks its actual admitted
backend name/OID against its sealed principal; class-to-worker equality makes the
same worker DB constraint mandatory. The physical2 core gate verifies actual worker backend identity when the
approved API is exercised; selected source/image execution remains unselected. Missing/mixed identity
refuses; no old ledger upgrade.

Each principal is exactly `{role,roleOid,database,databaseOid}`: names and decimal
OID strings are read from sealed private custody. Every authority-bearing regex
value must be a primitive string; regex coercion of arrays/objects is refused.
Source, principal, container, descriptor and ledger row objects must not be arrays. Commissioning has a separate
bootstrap DDL principal, never the ordinary operator credential. The three class
entries bind to the same resource and budget. Names/OIDs, source/image, epoch,
roster and action documents cannot be supplied by ordinary intent fields.

Lifecycle intent2 is exactly `{version:2,command,tenant}`, with command inspect,
clear-operations or capture; resume additionally requires only `claimId`, restore
additionally requires only `artifactDigest`. Tenant and claim are nonzero UUIDs;
digest is lowercase hex64. Plan roster admission remains the lifecycle binding's
responsibility. Commission intent2 is exactly `{version:2,command:'commission'}`;
its roster and principals are sealed host inputs, never request selectors. The
common `intent(class,value)` validates this closed vocabulary, before hashing.

## Exact common ledger3 row

Ledger root remains `{version:3,planSha256,resourceEpoch,slots,controlLeases}`.
`resourceEpoch=[systemIdentifier,postmasterStartedAt]`. A row is exactly:

```
{state, class, credits:1, incarnation, nonce, tags:[applicationName],
 intentSha256, planSha256, source, principal, container, stopped}
```

`state` is ISSUED, BOUND, UNKNOWN or CLOSED. Incarnation and nonce are distinct
fresh primitive-string 32-character lowercase hex values. Intent digest is 64-character lowercase
hex of the class-specific validated immutable action. Class-specific bindings
retain that action separately; the common allocator never dispatches it. Source
is the sealed plan source. Principal equals that class's sealed plan principal.
The exact tag is `nscb:<incarnation>:<sha256(class)[0:16]>`. Container is null
before binding or exactly `{cid,startedAt,project,workingDirectory,service,
imageId,source}`, with fixed service/class and sealed expected image/source.
`stopped` is null or exactly `{container,resourceEpoch,noFutureDispatch:true}`,
where container equals the durable bound container. UNKNOWN without a bound
container cannot acquire stopped proof and cannot admit a successor.

Worker slots retain their existing row format exactly:
`{incarnation,nonce,tags,container,state,retired}`. State is ISSUED or RETIRED, and
retired equals the state predicate. Incarnations and nonces are unique across
worker and control rows. Every worker tag derives from that slot's fixed admitted
capability key and incarnation, exactly once; missing/forged/duplicate tags and
malformed/duplicate/excess generations refuse before known-managed tag authority.
A retired worker requires its exact bound container. The existing declared worker
generation limits remain unchanged.

Only synchronous operations execute under the fsynced private F.locked lock.
Debit ISSUED is saved before any credential read, ticket publication or child
construction. Exact CID/start is saved as BOUND before opening authentication.
Any uncertainty becomes UNKNOWN and remains charged. Child waiting occurs
outside the lock. No Promise spans F.locked.

All non-CLOSED rows cost one shared controlRecovery credit, including UNKNOWN.
The fresh selected budget is exactly two. Globally at most one ISSUED/BOUND row
exists. A new row is permitted only if no active row exists, fewer than two
credits are held and every UNKNOWN predecessor has exact same-epoch stopped /
no-future-dispatch proof. UNKNOWN commissioning makes setup terminal regardless
of stopped proof. A stopped proof permits another independently debited command;
it does not close or refund its predecessor. Two UNKNOWN rows exhaust both
credits. Late EOF/receipt/tag0, forced stop or later SQL settlement never closes
UNKNOWN. CLOSED requires a still-BOUND row, exact clean stopped identity, exact
receipt2/quiescence and separately charged exact zero-tag census.

## Tickets, completion and observations

Fresh admission ticket2 keeps its reviewed core fields plus workerDatabase above; legacy ticket1 remains exact. Its controller-private `control` member
is exactly `{version:2,class,intentSha256,resourceEpoch,expected,principal,files}`;
class-specific action document is separately sealed and its digest is checked
before authentication. Gate2 is exactly `{version:2,class,incarnation,nonce,
intentSha256,container}`. Ordinary consumers cannot choose files or expected
identity. Receipt2 is exactly `{version:2,kind:'controlled-operation-complete',
class,incarnation,nonce,planSha256,source,intentSha256,container,outcome,result,
quiescence}`; outcome COMPLETED or REFUSED. Quiescence is actual core proof
matching class/process/incarnation/nonce/plan/source/tag, constructors frozen,
pendingConnects0/liveConnections0, no unconfirmed cleanup and clean shutdown.
An observer census never substitutes for actual source EOF/quiescence.

Observation2 retains `kind:'controlled-connection-observation'`, planSha256,
source, expected, ledger, resource, tags, visibility, limitations, hostMonotonic.
It replaces occupancy with exactly:

```
{physical:{workers:<sum>,control:{'lifecycle-operator':<sum>,
 'restore-commissioner':<sum>,'realtime-recovery':<sum>}},
 heldControlCredits:<non-CLOSED sum>,activeControlExecutions:<ISSUED/BOUND count>}
```

Every requested tag derives only from all durable non-retired worker rows plus
all durable non-CLOSED class rows. Tag rows must equal this set exactly, including
UNKNOWN; missing/extra/duplicate/forged tags refuse. Physical counts measure
PG_STAT authenticated occupancy only. Separate independently charged observer
claim/journal records stay separate from class and worker occupancy; observer
backend counts never retire execution credit. Stored-count2 carries the same
ledger and occupancy plus complete tag rows and its existing fixed selector,
counts/foreign/custody/digest/diagnostic/time fields. Every stop path passes the
full exact outstanding set to observation. No class label exempts a backend from
clinical actor/census requirements.

The collector owner must independently review this exact tuple before accepting
it. The existing envelope1/ledger2 collector remains unchanged and rejects it.
Actual native audit/clinical/B/clock/pin oracle and source drill interfaces need
separate authored review/freeze before any native effects. This contract alone
proves none of native RLS, clinical safety or interrupted-state origin.
