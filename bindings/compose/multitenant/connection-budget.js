'use strict';

// Opt-in fixed-roster connection admission. No database/network access occurs
// in this module: the controlled adapter supplies bounded observations.
const crypto = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const fail = code => Object.assign(new Error(code), { code });
const need = (value, code) => { if (!value) throw fail(code); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && equal(Object.keys(value).sort(), [...keys].sort());
const integer = (value, min = 0, max = 1000000) => Number.isSafeInteger(value) && value >= min && value <= max;
const hex = (value, n) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + n + '}$').test(value);
const id = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(value);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Review-bounded inventory. A new core revision requires explicit re-review;
// matching config keys alone is not proof of complete constructor coverage.
const REVIEWED_CORE_COMMIT = 'd0036890d0623ae79f14bfa71e7226c0fa122a29';
const SOURCE = {
  'nightscout-api-registry': 'lib/server/serve/registry-tenants.js',
  'nightscout-tenant-admin-registry': 'lib/server/serve/registry-tenants.js',
  'nightscout-legacy-authority': 'lib/secrets/legacy-postgres.js',
  'nightscout-tenant-authorization': 'lib/tenant-authorization/postgres.js',
  'nightscout-current-access': 'lib/tenant-authorization/access-postgres.js',
  'nightscout-secrets': 'lib/secrets/postgres.js',
  'nightscout-preview-data': 'lib/server/serve/preview-api.js',
  'nightscout-subject-admin': 'lib/subject-admin/postgres.js',
  'nightscout-display-settings': 'lib/tenant-settings/effective-postgres.js',
  'nightscout-api-activity': 'lib/tenant-activity/postgres.js',
  'nightscout-realtime-activity': 'lib/tenant-activity/postgres.js',
  'nightscout-evaluator-activity': 'lib/tenant-activity/postgres.js',
  'nightscout-socket-alarm': 'lib/server/realtime/private-api.js',
  'nightscout-realtime-registry': 'lib/server/serve/registry-tenant-set.js',
  'nightscout-evaluator-registry': 'lib/server/serve/registry-tenant-set.js',
  'nightscout-realtime-registry-lookup': 'lib/server/serve/preview-realtime.js',
  'nightscout-realtime-preview': 'lib/server/serve/preview-realtime.js',
  'nightscout-realtime-owner': 'lib/server/serve/preview-realtime.js',
  'nightscout-evaluator-preview': 'lib/server/serve/evaluator-preview.js',
  'nightscout-pool-evaluator': 'lib/pool-membership/postgres.js',
  'nightscout-admin-pool': 'lib/pool-membership/postgres.js',
  'nightscout-evaluator-consumer-preview': 'lib/server/serve/evaluator-consumers.js',
  'nightscout-operation-lifetime': 'lib/server/serve/index.js',
  'nightscout-ownership-ops': 'lib/tenant-ownership/postgres.js',
  'nightscout-admin-ownership-registry': 'lib/server/serve/admin-preview.js',
  'nightscout-management-sessions': 'lib/management-sessions/postgres.js',
  'nightscout-admin-provisioning': 'lib/tenant-registry/provision.js',
  'nightscout-connector-definitions': 'lib/tenant-connector/postgres-sources.js',
  'nightscout-ui-registry': 'bindings/compose/multitenant/ui-registry.js',
  'nightscout-feed-reader': 'lib/change-feed/postgres.js',
  'nightscout-feed-listener': 'lib/change-feed/consumer.js',
  'migration-direct': 'lib/migrations/postgres.js',
  'settings-readiness': 'lib/tenant-settings/readiness.js',
  'clinical-readiness': 'lib/server/serve/evaluator-readiness.js',
  'api-readiness': 'lib/server/serve/postgres-domains.js',
  'owner-readiness': 'lib/server/serve/owner-preview.js',
  'admin-readiness': 'lib/server/serve/admin-preview.js'
};

function expanded(docs) {
  need(docs && docs.configs && docs.environments && docs.operations && docs.admin && docs.feed && docs.ui, 'CONNECTION_PLAN_REGISTRY_GRAPH_REQUIRED');
  const rows = Object.entries(docs.configs).map(([name, config]) => ({ name, role: name.replace(/-\d+$/, ''), config, env: docs.environments[name], operation: docs.operations[name] }));
  rows.push({ name: 'admin', role: 'admin', config: docs.admin.config, env: docs.admin.environment },
    { name: 'feed-reader', role: 'feed-reader', config: docs.feed.config, env: docs.feed.environment },
    { name: 'ui', role: 'ui', config: docs.ui, env: docs.uiEnvironment });
  if (docs.realtimePlacement) rows.push({ name: 'socket-edge', role: 'socket-edge', config: docs.ui, env: docs.uiEnvironment });
  need(rows.length <= 128 && new Set(rows.map(x => x.name)).size === rows.length && rows.every(x => id(x.name) && x.env && x.config), 'CONNECTION_PLAN_EXPANDED_ROSTER');
  return rows;
}

function describe(docs, poolConfig) {
  return expanded(docs).map(row => {
    const { name, role, config: c, env, operation } = row;
    need(!(env.ENABLE || '').split(/\s+/).includes('oidc'), 'CONNECTION_PLAN_OIDC_GRAPH_UNKNOWN');
    const capabilities = {};
    const pool = (key, maximum, held = 0) => {
      need(SOURCE[key] && integer(maximum, 1, 1000) && integer(held) && held <= maximum && !capabilities[key], 'CONNECTION_PLAN_CONSTRUCTOR_UNKNOWN');
      capabilities[key] = { kind: 'pool', requestedMaximum: maximum, heldWithinPool: held, source: SOURCE[key] };
    };
    const direct = key => { need(SOURCE[key] && !capabilities[key], 'CONNECTION_PLAN_CONSTRUCTOR_UNKNOWN'); capabilities[key] = { kind: 'client', source: SOURCE[key] }; };
    need(c.registry || role === 'admin' || role === 'feed-reader', 'CONNECTION_PLAN_REGISTRY_GRAPH_REQUIRED');
    if (role === 'api') {
      pool('nightscout-api-registry', 2); pool('nightscout-legacy-authority', 4); pool('nightscout-tenant-authorization', 4); pool('nightscout-secrets', 4);
      pool('nightscout-preview-data', poolConfig.pool('api', env).max);
      for (const [feature, key, maximum] of [['accessTokens', 'nightscout-current-access', 4], ['subjectAdmin', 'nightscout-subject-admin', 4], ['tenantSettings', 'nightscout-display-settings', 4], ['activity', 'nightscout-api-activity', 2], ['socketForwarding', 'nightscout-socket-alarm', 4]]) if (c[feature]) pool(key, maximum);
      direct('api-readiness'); direct('migration-direct'); if (c.tenantSettings) direct('settings-readiness');
    } else if (role === 'realtime') {
      pool('nightscout-realtime-registry', 1); pool('nightscout-realtime-registry-lookup', 2); pool('nightscout-realtime-preview', poolConfig.pool('realtime', env, { connectionTimeoutMillis: c.operationTimeoutMs }).max);
      if (c.tenantSettings) { pool('nightscout-display-settings', 4); direct('settings-readiness'); }
      if (env.MULTITENANT_REALTIME_PLACEMENT) pool('nightscout-realtime-owner', 1, 1);
      if (c.activity) pool('nightscout-realtime-activity', 2);
      if (c.changeFeed) direct('nightscout-feed-listener');
      direct('clinical-readiness'); direct('migration-direct');
    } else if (role === 'evaluator') {
      pool('nightscout-evaluator-registry', 1); pool('nightscout-evaluator-preview', poolConfig.pool('evaluator', env).max);
      if (c.tenantSettings) { pool('nightscout-display-settings', 4); direct('settings-readiness'); }
      if (env.MULTITENANT_POOL_EVALUATOR_PARTITION === 'on') pool('nightscout-pool-evaluator', 2);
      if (c.activity) pool('nightscout-evaluator-activity', 2);
      if (c.changeFeed) direct('nightscout-feed-listener');
      if (c.consumers) {
        need(exact(c.consumers, ['realtime']), 'CONNECTION_PLAN_CONSUMER_UNKNOWN');
        need(c.consumers.realtime.outbox.maxConnections === c.consumers.realtime.suppression.maxConnections, 'CONNECTION_PLAN_CONSUMER_BINDING_UNKNOWN');
        pool('nightscout-evaluator-consumer-preview', c.consumers.realtime.outbox.maxConnections);
        capabilities['nightscout-evaluator-consumer-preview'].minimumInstances = 2;
      }
      direct('clinical-readiness'); direct('migration-direct');
    } else if (role === 'tenant-admin') {
      pool('nightscout-tenant-admin-registry', 2); pool('nightscout-current-access', 4); pool('nightscout-subject-admin', 4);
      need(!c.ownerSettings && !c.ownerActivity && !c.ownerCredentials, 'CONNECTION_PLAN_OWNER_EXTENSION_UNKNOWN');
      direct('owner-readiness'); direct('migration-direct');
    } else if (role === 'admin') {
      for (const [feature, key, maximum] of [['ownership', 'nightscout-ownership-ops', 4], ['pools', 'nightscout-admin-pool', 2], ['managementSessions', 'nightscout-management-sessions', 4], ['provisioning', 'nightscout-admin-provisioning', 4], ['connectorSources', 'nightscout-connector-definitions', 2]]) if (c[feature]) pool(key, maximum);
      if (c.ownership?.registry) pool('nightscout-admin-ownership-registry', 1);
      direct('admin-readiness'); direct('migration-direct');
    } else if (role === 'feed-reader') direct('nightscout-feed-reader');
    else if (role === 'ui' || role === 'socket-edge') pool('nightscout-ui-registry', 2);
    else throw fail('CONNECTION_PLAN_ROLE_UNKNOWN');
    if (operation) {
      need(integer(operation.leaseSessions, 1, poolConfig.pool('operation', env).max), 'CONNECTION_PLAN_LIFETIME_UNKNOWN');
      pool('nightscout-operation-lifetime', poolConfig.pool('operation', env).max, operation.leaseSessions);
    }
    return { processInstanceId: name, roles: [role], capabilities, startupConcurrency: poolConfig.startupConcurrency(env) };
  });
}

function validateResource(r) {
  need(exact(r, ['pgResourceId', 'systemIdentifier', 'postmasterStartedAt', 'serverMaximum', 'reserved', 'aliases', 'allowances']), 'CONNECTION_PLAN_RESOURCE_SHAPE');
  need(id(r.pgResourceId) && /^\d{1,24}$/.test(r.systemIdentifier) && typeof r.postmasterStartedAt === 'string' && r.postmasterStartedAt.length <= 64, 'CONNECTION_PLAN_RESOURCE_IDENTITY');
  need(integer(r.serverMaximum, 1) && exact(r.reserved, ['superuser', 'other']) && Object.values(r.reserved).every(x => integer(x)) && r.serverMaximum > r.reserved.superuser + r.reserved.other, 'CONNECTION_PLAN_SETTINGS_UNKNOWN');
  need(Array.isArray(r.aliases) && r.aliases.length > 0 && r.aliases.length <= 32 && r.aliases.every(x => typeof x === 'string' && /^[a-z0-9.\[\]:-]{1,255}$/.test(x)) && new Set(r.aliases).size === r.aliases.length, 'CONNECTION_PLAN_ALIASES');
  need(exact(r.allowances, ['unmanaged', 'observers', 'controlRecovery', 'bootstrapOverlap', 'oldNewRolloutOverlap']) && Object.values(r.allowances).every(x => integer(x)) && r.allowances.observers >= 2 && r.allowances.controlRecovery > 0, 'CONNECTION_PLAN_HEADROOM_UNKNOWN');
  return r;
}

function compile(profile, docs, { source, poolConfig }) {
  need(exact(profile, ['version', 'kind', 'source', 'resource', 'slots', 'bootstrapSchedule']) && [1,2].includes(profile.version) && profile.kind === 'explicit-connection-budget-profile' && equal(profile.source, source), 'CONNECTION_PLAN_PROFILE_SOURCE');
  need(hex(source.coreCommit, 40) && hex(source.deployCommit, 40), 'CONNECTION_PLAN_SOURCE_REQUIRED');
  const resource = validateResource(profile.resource), descriptors = describe(docs, poolConfig);
  need(Array.isArray(profile.slots) && equal(profile.slots.map(x => x.processInstanceId).sort(), descriptors.map(x => x.processInstanceId).sort()), 'CONNECTION_PLAN_ROSTER_MISMATCH');
  need(profile.bootstrapSchedule === 'CONTROLLER_CONFIRMED_CLOSED_BEFORE_WORKERS' || profile.bootstrapSchedule === 'EXPLICIT_OVERLAP', 'CONNECTION_PLAN_BOOTSTRAP_UNKNOWN');
  // Bootstrap's two untagged direct clients retain explicit credits even after
  // process exit; a timestamp or single census is not handshake retirement.
  need(resource.allowances.bootstrapOverlap >= 2, 'CONNECTION_PLAN_BOOTSTRAP_UNKNOWN');
  const slots = descriptors.map(description => {
    const given = profile.slots.find(x => x.processInstanceId === description.processInstanceId);
    need(exact(given, ['processInstanceId', 'capabilities', 'directGroups', 'cold', 'maximumOutstandingGenerations']), 'CONNECTION_PLAN_SLOT_SHAPE');
    need(equal(Object.keys(given.capabilities).sort(), Object.keys(description.capabilities).sort()), 'CONNECTION_PLAN_CONSTRUCTOR_COVERAGE');
    need(integer(given.maximumOutstandingGenerations, 1, 16) && given.directGroups && Object.values(given.directGroups).every(x => integer(x, 1, 1000)), 'CONNECTION_PLAN_CONCURRENCY_UNKNOWN');
    need(exact(given.cold, ['activeLimit', 'pendingLimit', 'minDelayMs', 'maxDelayMs']) && integer(given.cold.activeLimit, 1, 1000) && integer(given.cold.pendingLimit, 1, 1000000) && integer(given.cold.minDelayMs, 1, 60000) && integer(given.cold.maxDelayMs, given.cold.minDelayMs, 60000), 'CONNECTION_PLAN_COLD_UNKNOWN');
    need(given.cold.activeLimit + given.cold.pendingLimit >= description.startupConcurrency * (description.roles[0] === 'evaluator' ? 2 : 1) + 1, 'CONNECTION_PLAN_SELF_OVERLOAD');
    const capabilities = {};
    let cost = 0;
    for (const [key, described] of Object.entries(description.capabilities)) {
      const selected = given.capabilities[key];
      if (described.kind === 'pool') {
        need(exact(selected, ['kind', 'poolMax', 'maxInstances']) && selected.kind === 'pool' && integer(selected.poolMax, 1, described.requestedMaximum) && integer(selected.maxInstances, 1, 16), 'CONNECTION_PLAN_POOL_LIMIT');
        need(described.heldWithinPool <= selected.poolMax && selected.maxInstances >= (described.minimumInstances || 1), 'CONNECTION_PLAN_LIFETIME_EXCEEDS_POOL');
        // Evaluator's retained settings lifecycle admits one pool and4 whole
        // refresh/read chains. Per-capability size is explicit, never implicit.
        if (description.roles[0] === 'evaluator' && key === 'nightscout-display-settings') need(selected.maxInstances === 1, 'CONNECTION_PLAN_SETTINGS_OVERLAP');
        capabilities[key] = { ...selected, metadata: { source: described.source, requestedMaximum: described.requestedMaximum, heldWithinPool: described.heldWithinPool, configurationSource: 'explicit-profile' } };
        cost += selected.poolMax * selected.maxInstances;
      } else {
        need(exact(selected, ['kind', 'directGroup']) && selected.kind === 'client' && typeof selected.directGroup === 'string' && Object.hasOwn(given.directGroups, selected.directGroup), 'CONNECTION_PLAN_DIRECT_UNKNOWN');
        capabilities[key] = { ...selected, metadata: { source: described.source, configurationSource: 'explicit-profile' } };
      }
    }
    const usedGroups = new Set(Object.values(capabilities).filter(x => x.kind === 'client').map(x => x.directGroup));
    need(equal([...usedGroups].sort(), Object.keys(given.directGroups).sort()), 'CONNECTION_PLAN_DIRECT_UNKNOWN');
    // A persistent LISTEN/reader may not share a transient admission group:
    // doing so could pin every direct-check slot forever.
    for (const key of ['nightscout-feed-listener', 'nightscout-feed-reader']) if (capabilities[key]) {
      const g = capabilities[key].directGroup;
      need(Object.entries(capabilities).filter(([, x]) => x.kind === 'client' && x.directGroup === g).length === 1, 'CONNECTION_PLAN_PERSISTENT_DIRECT_GROUP');
    }
    if (description.roles[0] === 'evaluator' && capabilities['settings-readiness']) {
      need(capabilities['settings-readiness'].directGroup === capabilities['migration-direct'].directGroup && given.directGroups[capabilities['settings-readiness'].directGroup] >= 4, 'CONNECTION_PLAN_SETTINGS_DIRECT_BOUND');
    }
    cost += Object.values(given.directGroups).reduce((a, b) => a + b, 0);
    return { ...given, roles: description.roles, startupConcurrency: description.startupConcurrency, capabilities, declaredMaximum: cost };
  });
  const declaredMaximum = slots.reduce((n, x) => n + x.declaredMaximum, 0);
  const outside = Object.values(resource.allowances).reduce((a, b) => a + b, 0);
  const usable = resource.serverMaximum - resource.reserved.superuser - resource.reserved.other;
  need(declaredMaximum + outside <= usable, 'CONNECTION_PLAN_OVERCOMMITTED');
  const plan = { version: profile.version, kind: 'controlled-connection-budget-plan', source, resource, slots,
    bootstrapSchedule: profile.bootstrapSchedule, declaredMaximum, outside, usable, authorization: 'CONTROLLED_SOURCE_ADMISSION_ONLY_NOT_CAPACITY' };
  return { ...plan, sha256: hash(plan) };
}

function observedResourceMatches(plan, observation) {
  const r = plan.resource;
  need(exact(observation, ['pgResourceId', 'systemIdentifier', 'postmasterStartedAt', 'serverMaximum', 'superuserReserved', 'otherReserved', 'unmanagedClients', 'bootstrapClosed']), 'CONNECTION_ADMISSION_OBSERVATION_UNKNOWN');
  need(observation.pgResourceId === r.pgResourceId && observation.systemIdentifier === r.systemIdentifier && observation.postmasterStartedAt === r.postmasterStartedAt && observation.serverMaximum === r.serverMaximum && observation.superuserReserved === r.reserved.superuser && observation.otherReserved === r.reserved.other, 'CONNECTION_ADMISSION_RESOURCE_CHANGED');
  need(integer(observation.unmanagedClients) && observation.unmanagedClients <= r.allowances.unmanaged, 'CONNECTION_ADMISSION_OUTSIDE_BUDGET');
  if (plan.bootstrapSchedule === 'CONTROLLER_CONFIRMED_CLOSED_BEFORE_WORKERS') need(observation.bootstrapClosed === true, 'CONNECTION_ADMISSION_BOOTSTRAP_OPEN');
}

function ledger(plan) { return { version: 1, planSha256: plan.sha256, resourceEpoch: [plan.resource.systemIdentifier, plan.resource.postmasterStartedAt], slots: Object.fromEntries(plan.slots.map(x => [x.processInstanceId, []])) }; }
function generation(plan, book, slotId, observation, previousProof = null, random = crypto.randomBytes) {
  observedResourceMatches(plan, observation);
  need(book.planSha256 === plan.sha256 && equal(book.resourceEpoch, [plan.resource.systemIdentifier, plan.resource.postmasterStartedAt]) && equal(Object.keys(book.slots).sort(), plan.slots.map(x => x.processInstanceId).sort()), 'CONNECTION_ADMISSION_LEDGER_CHANGED');
  const slot = plan.slots.find(x => x.processInstanceId === slotId); need(slot, 'CONNECTION_ADMISSION_UNPLANNED_WORKER');
  const old = book.slots[slotId];
  if (old.length) {
    const latest = old.at(-1);
    if (latest.state !== 'RETIRED' && previousProof) retire(plan, book, slotId, previousProof);
  }
  const outstanding = old.filter(x => x.state !== 'RETIRED');
  need(outstanding.length < slot.maximumOutstandingGenerations, 'CONNECTION_ADMISSION_GENERATIONS_EXHAUSTED');
  const oldCredits = plan.slots.reduce((total, s) => total + Math.max(0, book.slots[s.processInstanceId].filter(x => x.state !== 'RETIRED').length - (s.processInstanceId === slotId ? 0 : 1)) * s.declaredMaximum, 0);
  need(oldCredits <= plan.resource.allowances.oldNewRolloutOverlap, 'CONNECTION_ADMISSION_OLD_CREDITS_HELD');
  const incarnation = random(16).toString('hex'), nonce = random(16).toString('hex');
  need(hex(incarnation, 32) && hex(nonce, 32) && !Object.values(book.slots).flat().some(x => x.incarnation === incarnation), 'CONNECTION_ADMISSION_NONCE');
  const tags = Object.keys(slot.capabilities).map(name => 'nscb:' + incarnation + ':' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 16));
  need(new Set(tags).size === tags.length, 'CONNECTION_ADMISSION_TAG_COLLISION');
  const row = { incarnation, nonce, tags, container: null, state: 'ISSUED', retired: false };
  old.push(row);
  return { version: 1, planSha256: plan.sha256, processInstanceId: slotId, incarnation, nonce, source: plan.source,
    pgResourceId: plan.resource.pgResourceId, resourceAliases: plan.resource.aliases, capabilities: slot.capabilities, directGroups: slot.directGroups, cold: slot.cold };
}

// Bind the first actual owned process identity before any retirement proof can
// release its credits. Never infer this identity from the later stop request.
function recordStarted(plan, book, slotId, incarnation, container) {
  need(book.planSha256 === plan.sha256 && book.slots[slotId], 'CONNECTION_ADMISSION_LEDGER_CHANGED');
  const row = book.slots[slotId].find(x => x.incarnation === incarnation);
  need(row && row.state === 'ISSUED' && row.container === null, 'CONNECTION_ADMISSION_ALREADY_BOUND');
  need(exact(container, ['cid', 'startedAt', 'project', 'workingDirectory', 'service', 'imageId', 'source']) && hex(container.cid, 64)
    && typeof container.startedAt === 'string' && container.startedAt.length > 0 && container.startedAt.length <= 64
    && id(container.project) && container.service === slotId && typeof container.workingDirectory === 'string' && container.workingDirectory.startsWith('/')
    && /^sha256:[a-f0-9]{64}$/.test(container.imageId) && equal(container.source, plan.source), 'CONNECTION_ADMISSION_CONTAINER_CUSTODY');
  row.container = structuredClone(container);
}

function retire(plan, book, slotId, proof) {
  const old = book.slots[slotId].find(x => x.incarnation === proof.incarnation); need(old, 'CONNECTION_ADMISSION_OLD_GENERATION_UNKNOWN');
  need(exact(proof, ['incarnation', 'nonce', 'planSha256', 'source', 'oldCid', 'oldStartedAt', 'stoppedCid', 'stoppedStartedAt', 'stopped', 'ack', 'pgTagRows', 'resourceEpoch']), 'CONNECTION_ADMISSION_RETIREMENT_UNKNOWN');
  need(proof.nonce === old.nonce && proof.planSha256 === plan.sha256 && equal(proof.source, plan.source) && equal(proof.resourceEpoch, book.resourceEpoch), 'CONNECTION_ADMISSION_STALE_PROOF');
  need(old.container && proof.oldCid === old.container.cid && proof.oldStartedAt === old.container.startedAt && hex(proof.oldCid, 64) && proof.oldCid === proof.stoppedCid && typeof proof.oldStartedAt === 'string' && proof.oldStartedAt === proof.stoppedStartedAt && proof.stopped === true, 'CONNECTION_ADMISSION_OLD_CID_NOT_STOPPED');
  const a = proof.ack;
  need(a && a.planSha256 === plan.sha256 && a.processInstanceId === slotId && a.incarnation === old.incarnation && a.nonce === old.nonce && equal(a.source, plan.source)
    && a.constructorsFrozen === true && a.pendingConnects === 0 && a.liveConnections === 0 && a.unconfirmedCleanup === false && a.cleanShutdown === true, 'CONNECTION_ADMISSION_QUIESCENCE_UNPROVEN');
  need(Array.isArray(a.tags) && equal([...a.tags].sort(), [...old.tags].sort()) && a.tags.length > 0 && a.tags.every(x => typeof x === 'string' && Buffer.byteLength(x) <= 63 && /^[a-zA-Z0-9_.:~-]+$/.test(x)) && Array.isArray(proof.pgTagRows)
    && proof.pgTagRows.every(x => exact(x, ['applicationName', 'count']) && a.tags.includes(x.applicationName) && x.count === 0)
    && equal(proof.pgTagRows.map(x => x.applicationName).sort(), [...new Set(a.tags)].sort()), 'CONNECTION_ADMISSION_OLD_BACKENDS_PRESENT');
  old.state = 'RETIRED'; old.retired = true;
}

module.exports = { REVIEWED_CORE_COMMIT, SOURCE, expanded, describe, compile, observedResourceMatches, ledger, generation, recordStarted, retire, hash };
