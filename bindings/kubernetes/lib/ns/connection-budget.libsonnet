// PostgreSQL connection budget and planned memory (decisions pg-connection-budget,
// pg-connection-pooler-allowed, stateful-evaluator-resident-window, requests-typical-scheduler-decides).
//
//   budget          = Σ over pods (pool max per role) + transient + superuser + clinical reserve
//   max_connections = budget (never below the PostgreSQL 140/40 default), or an explicit
//                     postgresMaxConnections that must hold the budget (an over-budget pool set refuses)
//   postgres memory request = typical + perConnectionMiB × (max_connections − 140) + postgresShmMiB
//                     (the memory-backed /dev/shm volume is charged to the Pod)
//   evaluator memory request = baseMiB + perResidentMiB × residentMax,
//                     NS_EVALUATOR_RESIDENT_MAX = residentMax (requests only, no limit)
//   evaluator V8 heap ceiling = ceil(heapHeadroom × memory request), passed as the node flag
//                     --max-old-space-size (MiB) in the evaluator command. Without it V8's default
//                     old-space limit (about 4 GB on the 64-bit Node 24 image) ends the process
//                     ("JavaScript heap out of memory", exit 139) below the planned request.
//   residentMax     = min(tenantCount, ceil(mean + z × sqrt(mean × (1 − 1/K)))), mean = tenantCount / K,
//                     z = residentHeadroomZ (default 4.5). Ownership is sha256-modulo-v1 over tenant ids
//                     unknown at render time, so the busiest slice is Binomial(tenantCount, 1/K) above the
//                     mean (smoke: 53 of 50 at K=2, 30 of 25 at K=4). Chance any slice exceeds z=4.5:
//                     <= 8e-5 for K <= 8, tenantCount >= 100 (exact binomial tail); at 10,000 tenants
//                     9.0e-5 for K=20 and 1.9e-4 for K=32 (union bound over slices). Over the limit the
//                     runtime evicts and reloads (evaluator-runtime.js trimResidents); it does not refuse.
//
// Per-process pools, read at core 80972e7ae (labels: read-derived; the harness reads connections
// in use back against these terms). Every pool is per process, never per tenant; `max` is a
// ceiling (node-pg opens on demand and closes idle clients after 10 s).
//   api:          data NS_POOL_API_MAX (preview-api.js:70) + display settings NS_POOL_API_MAX
//                 (effective-postgres.js:55) + secrets 4 (secrets/postgres.js:43) + registry 2
//                 (registry-tenants.js:39) + socket alarm 4 (realtime/private-api.js:106)
//                 + operation NS_POOL_OPERATION_MAX (serve/index.js:143)
//   realtime:     data NS_POOL_REALTIME_MAX (preview-realtime.js:114) + read 2 (postgres-connection.js:95,
//                 NS_POOL_READ_MAX not honoured) + registry 2 (registry-tenant-set.js:118) + owner 1
//                 (preview-realtime.js:122) + operation
//   evaluator:    data NS_POOL_EVALUATOR_MAX (evaluator-preview.js:155) + read NS_POOL_READ_MAX
//                 + registry 2 (evaluator-preview.js:120, demand mode) + outbox 2 + suppression 2
//                 (deployment-settings.js:193-194) + operation
//   tenant-admin: 40 with every owner option (owner-preview.js), operation pool included; fixed literals
//   admin:        15 (ownership 4, registry 1, sessions 4, provisioning 4, connector sources 2); fixed
//   vcpool:       10 when enabled (secrets 4 secrets/postgres.js:44, activity 2 tenant-activity/postgres.js:61,
//                 registry view 2 tenant-connector/registry-view.js:18, definitions 2 postgres-sources.js:59); fixed
//   transient:    single Clients for health and readiness, about 3 at once per serving Pod (role-health.js:43,
//                 role-readiness.js:37)
{
  defaults:: {
    pools: { api: 4, realtime: 4, evaluator: 4, operation: 8, read: 2 },
    // Fixed per-process pools (source literals at core 80972e7ae).
    fixed: { api: 10, realtime: 5, evaluator: 6, 'tenant-admin': 40, admin: 15 },
    transientPerPod: 3,
    superuserReserved: 3,
    clinicalReserved: 40,
    postgresDefault: 140,
    // Read-derived: private memory of an idle backend; refit from a run.
    postgresPerConnectionMiB: 2,
    // Size of the memory-backed /dev/shm volume (dynamic shared memory for parallel query and hash
    // joins). It is charged to the Pod's memory, so the request includes all of it.
    postgresShmMiB: 1024,
    // Upper envelope of the measured evaluator resident-set peaks on the v2 client-model history
    // with the window levers on (plannable-scale discovery 2026-11-21/22, 17 evaluator Pods at
    // 223..1,032 residents): least squares 1,109.9 + 2.961 x residents MiB (R^2 0.90), intercept
    // raised by the largest residual (632.4 MiB, K=2 at 475) so every measured peak is at or below
    // the line. The 1,000-resident peaks sat at V8's default heap ceiling, so the slope is a floor.
    evaluatorMemory: { baseMiB: 1745, perResidentMiB: 2.96, heapHeadroom: 1.5 },
    residentHeadroomZ: 4.5,
  },

  local integer(x) = std.isNumber(x) && x == std.floor(x),

  // c: the merged binding inputs.
  plan(c)::
    local d = $.defaults;
    local p = std.mergePatch(d.pools, std.get(c, 'pools', {}));
    assert std.length([r for r in std.objectFields(p) if !std.member(std.objectFields(d.pools), r)]) == 0 : 'pools names an unknown pool';
    assert std.length([r for r in std.objectFields(p) if !(integer(p[r]) && p[r] >= 1 && p[r] <= 1000)]) == 0 : 'pools: each pool max must be an integer 1..1000';
    assert p.evaluator >= 2 : 'pools.evaluator must be at least 2 (core refuses below 2)';
    local em = std.mergePatch(d.evaluatorMemory, std.get(c, 'evaluatorMemory', {}));
    assert std.isNumber(em.baseMiB) && em.baseMiB > 0 && std.isNumber(em.perResidentMiB) && em.perResidentMiB >= 0 : 'evaluatorMemory needs a positive baseMiB and a non-negative perResidentMiB';
    assert std.isNumber(em.heapHeadroom) && em.heapHeadroom >= 1 && em.heapHeadroom <= 4 : 'evaluatorMemory.heapHeadroom must be a number from 1 to 4 (the V8 heap ceiling is never below the memory request)';
    local perConn = std.get(c, 'postgresPerConnectionMiB', d.postgresPerConnectionMiB);
    assert std.isNumber(perConn) && perConn >= 0 : 'postgresPerConnectionMiB must be non-negative';
    local api = c.apiReplicas, kr = c.slices.realtime, ke = c.slices.evaluator;
    local vc = import 'vcpool.libsonnet';
    local perPod = {
      api: 2 * p.api + d.fixed.api + p.operation,
      realtime: p.realtime + d.fixed.realtime + p.operation,
      evaluator: p.evaluator + p.read + d.fixed.evaluator + p.operation,
      'tenant-admin': d.fixed['tenant-admin'],
      admin: d.fixed.admin,
    } + (if vc.enabled(c) then { vcpool: vc.fixedPool } else {});
    // vcpool (vcpool.libsonnet): one Pod when enabled, fixed pools only; absent when off.
    local pods = { api: api, realtime: kr, evaluator: ke, 'tenant-admin': 1, admin: 1 } + (if vc.enabled(c) then { vcpool: vc.pods(c) } else {});
    local pools = std.foldl(function(s, r) s + pods[r] * perPod[r], std.objectFields(pods), 0);
    local podCount = std.foldl(function(s, r) s + pods[r], std.objectFields(pods), 0);
    local transient = d.transientPerPod * podCount;
    local budget = pools + transient + d.superuserReserved + d.clinicalReserved;
    local explicit = std.get(c, 'postgresMaxConnections', null);
    assert explicit == null || (integer(explicit) && explicit >= 44 && explicit <= 10000) :
      'postgresMaxConnections must be null or an integer from 44 to 10000';
    local maxConnections = if explicit == null then std.max(d.postgresDefault, budget) else explicit;
    assert explicit == null || maxConnections >= budget :
      'postgresMaxConnections ' + maxConnections + ' is below the connection budget ' + budget +
      ' (pools ' + pools + ' + transient ' + transient + ' + superuser ' + d.superuserReserved + ' + clinical reserve ' + d.clinicalReserved + ')';
    local z = std.get(c, 'residentHeadroomZ', d.residentHeadroomZ);
    assert std.isNumber(z) && z >= 0 && z <= 10 : 'residentHeadroomZ must be a number from 0 to 10';
    local mean = c.tenantCount / ke;
    local owned = std.ceil(mean);
    local residentMax = std.min(c.tenantCount, std.ceil(mean + z * std.sqrt(mean * (1 - 1 / ke))));
    local memoryRequestMiB = std.ceil(em.baseMiB + em.perResidentMiB * residentMax);
    local heapMiB = std.ceil(em.heapHeadroom * memoryRequestMiB);
    {
      pools: p,
      perPod: perPod,
      pods: pods,
      poolConnections: pools,
      transient: transient,
      superuserReserved: d.superuserReserved,
      clinicalReserved: d.clinicalReserved,
      budget: budget,
      maxConnections: maxConnections,
      formula: 'sum(pods x pool max per role) + transientPerPod x pods + superuser + clinical reserve <= max_connections',
      postgresShmMiB: d.postgresShmMiB,
      postgresMemoryMiB: perConn * std.max(0, maxConnections - d.postgresDefault) + d.postgresShmMiB,
      postgresPerConnectionMiB: perConn,
      evaluator: {
        ownedPerSlice: owned,
        residentMax: residentMax,
        residentHeadroomZ: z,
        baseMiB: em.baseMiB,
        perResidentMiB: em.perResidentMiB,
        memoryRequestMiB: memoryRequestMiB,
        heapHeadroom: em.heapHeadroom,
        heapMiB: heapMiB,
      },
      // The evaluator command: the V8 heap ceiling is a node flag, never NODE_OPTIONS (the private
      // role environment refuses NODE_OPTIONS in both bindings).
      evaluatorCommand: ['node', '--max-old-space-size=' + std.toString(heapMiB), 'deploy/multitenant/entrypoint.js', 'evaluator'],
      // Environment each role process receives (NS_POOL_<ROLE>_MAX; core pool-config.js).
      env(role)::
        [{ name: 'NS_POOL_OPERATION_MAX', value: std.toString(p.operation) }] +
        (if role == 'api' then [{ name: 'NS_POOL_API_MAX', value: std.toString(p.api) }]
         else if role == 'realtime' then [{ name: 'NS_POOL_REALTIME_MAX', value: std.toString(p.realtime) }]
         else if role == 'evaluator' then [
           { name: 'NS_POOL_EVALUATOR_MAX', value: std.toString(p.evaluator) },
           { name: 'NS_POOL_READ_MAX', value: std.toString(p.read) },
           { name: 'NS_EVALUATOR_RESIDENT_MAX', value: std.toString(residentMax) },
         ] else []),
    },

  // Quantity helpers: MiB numbers to a Kubernetes quantity, and a typical quantity to MiB.
  mib(q)::
    local s = std.toString(q);
    if std.endsWith(s, 'Gi') then std.parseInt(std.substr(s, 0, std.length(s) - 2)) * 1024
    else if std.endsWith(s, 'Mi') then std.parseInt(std.substr(s, 0, std.length(s) - 2))
    else error 'memory quantity must be Mi or Gi: ' + s,
  quantity(m):: std.toString(std.ceil(m)) + 'Mi',
}
