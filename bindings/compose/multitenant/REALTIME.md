# Fixed realtime workers and controlled moves

This binding selects a fixed worker roster and a stable logical tenant partition.
The implementation is on the local M7 branch; native deployment acceptance and
horizontal capacity remain unmeasured. The default topology keeps one unsharded
realtime process. There is no production shard-count default.

Select both `NS_REALTIME_WORKERS` (1..16) and `NS_REALTIME_SHARDS` (1..4,096) when
running `prepare.js`. For example, two workers and eight logical shards exercise
placement independently of worker count. The binding's narrower shard bound keeps
complete transition documents within the product's one-MiB map bound. It is not a
measured capacity recommendation. Changing worker count does not change the hash
rule or logical shard count; repartition requires a separate migration.

Preparation writes `state/compose.realtime.yaml` and two private files in
`state/placement/`. Include the realtime override after the base Compose file and
`state/compose.replicas.yaml` in **every** bootstrap/start/operator invocation.
Bootstrap then generates one role directory per worker. Keep the normal documented
provision → commission restore → API → prime → publish → remaining roles sequence.

Every role and the operator mount the placement **directory**, so atomic renames
are visible. `backend.json` is the authoritative assignment used by realtime and
maintenance. `routes.json` is the admitted edge/alarm routing view. Their initial
bytes are identical; a controlled move stages the new assignment before publishing
the same bytes to the routing view. The registry resolves each public Host to a
canonical tenant; the private socket edge selects only its configured owner. No
request can supply a destination. Backend admission independently checks actual
ownership, activity and warm state.

All fixed workers, including idle workers, remain in the maintenance roster with
exact private sockets and actual boot incarnations. The durable realtime consumer
and checkpoint identity stay unchanged across moves. The resolver identity has no
clinical read/write or registry enumeration capability. The socket edge streams
polling and WebSocket traffic; it bounds connections globally and preserves idle
polling while retaining a separate short connection-establishment deadline.

## Controlled replacement or shard move

Run `replace-realtime.js` on the operator's Docker host, with the exact project,
state directory and every Compose file used for that deployment:

```bash
node deploy/multitenant/replace-realtime.js \
  --project "$NS_M7_PROJECT" --state "$NS_M7_STATE" \
  --compose "$NS_M7_BASE_COMPOSE" \
  --compose "$NS_M7_API_COMPOSE" --compose "$NS_M7_REALTIME_COMPOSE" \
  --worker realtime-1 --timeout 60000
```

This rotates that worker's boot incarnation while retaining its assignments. Add
`--shard 0 --to realtime-2` to move that one logical shard, provided it is currently
owned by the selected old worker. The old worker restarts with its remaining
assignments, possibly as an idle fixed participant. These are explicit operator
actions. Affected viewers reconnect; alerts for affected tenants can be delayed
while the owner is stopped and the replacement warms.

The host verifies the exact project/service/container, immutable paired image and
old boot metadata. It starts a private one-shot publisher using the existing
operator credential and the existing read-only activity credential. A bounded
stdin/stdout protocol requests only stop/confirmation/start actions; the container
receives no Docker socket and opens no control listener.

The product publisher first acquires the exclusive placement fence. A pinned
maintenance operation refuses the move **before** any owner is stopped. Inside
that fence the host stops the exact old container and confirms its terminated
process identity. The publisher fsyncs and renames the next assignment; the host
writes a fresh boot incarnation and starts its replacement. The publisher then
requires actual target health/owner-resource identity and readiness of eligible
tenants on changed assignments. It reads pause/suspend state through the narrow
activity reader; absence in a health array never proves a tenant is paused.
Unrelated cold tenants do not block the move. Only then are the authoritative
assignment bytes copied atomically into the edge/alarm routing view, before the
maintenance fence is released.

An unreadable map, unknown activity state, ambiguous old process, missing target,
failed warm or mismatched generation refuses. There is no fallback to an arbitrary
worker. Existing alarms retain the product's durable handoff guarantee; accepting
an older route generation requires the exact still-current worker/incarnation and
logical shard. A moved owner's old incarnation remains refused. Automatic failover
from an uncertain owner and durable replay to disconnected viewers are later
capabilities.

After an assignment rename, an error is an **uncertain new assignment**, never
permission to restore an older file or reuse an old incarnation. Retain the private
state and phase evidence. A retry can use a fresh confirmed generation when the
actual boot and current assignment agree. Failure before boot metadata activation
can instead produce `PLACEMENT_BOOT_IDENTITY_CHANGED`; explicit recovery for that
boundary remains unmeasured. Stop and diagnose it rather than editing the assignment
or silently declaring the old process dead. Native fault/recovery acceptance must
close that boundary before declaring this binding ready.
