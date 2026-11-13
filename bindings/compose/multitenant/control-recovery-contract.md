# Fresh common control recovery contract

SOURCE PROPOSAL FOR INDEPENDENT REVIEW. Runtime integration is open. This file
freezes the common boundary before collector or realtime bindings consume it.
It grants no executable source, image, resource or native-plan selection.

## Versions and fixed classes

Fresh profile2 compiles plan2 with `lifecycleOperator.version=2` and creates
ledger3 exclusively. Admission tickets retain core version1. Typed action intents,
completion receipts and observation/stored-count envelopes use version2. No
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
The actual realtime action vocabulary is separately owned and must be reviewed
before binding; reserving its class does not authorize dispatch or publication
retry. An uncertain publication journal cannot redispatch.

Plan2 contains `controlRecovery:{version:1,classes:{<each fixed class>:{principal}}}`.
Each principal is exactly `{role,roleOid,database,databaseOid}`: names and decimal
OID strings are read from sealed private custody. Commissioning has a separate
bootstrap DDL principal, never the ordinary operator credential. The three class
entries bind to the same resource and budget. Names/OIDs, source/image, epoch,
roster and action documents cannot be supplied by ordinary intent fields.

## Exact common ledger3 row

Ledger root remains `{version:3,planSha256,resourceEpoch,slots,controlLeases}`.
`resourceEpoch=[systemIdentifier,postmasterStartedAt]`. A row is exactly:

```
{state, class, credits:1, incarnation, nonce, tags:[applicationName],
 intentSha256, planSha256, source, principal, container, stopped}
```

`state` is ISSUED, BOUND, UNKNOWN or CLOSED. Incarnation and nonce are distinct
fresh 32-character lowercase hex values. Intent digest is 64-character lowercase
hex of the class-specific validated immutable action. Class-specific bindings
retain that action separately; the common allocator never dispatches it. Source
is the sealed plan source. Principal equals that class's sealed plan principal.
The exact tag is `nscb:<incarnation>:<sha256(class)[0:16]>`. Container is null
before binding or exactly `{cid,startedAt,project,workingDirectory,service,
imageId,source}`, with fixed service/class and sealed expected image/source.
`stopped` is null or exactly `{container,resourceEpoch,noFutureDispatch:true}`,
where container equals the durable bound container. UNKNOWN without a bound
container cannot acquire stopped proof and cannot admit a successor.

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

Admission ticket1 keeps its core fields. Its controller-private `control` member
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
