'use strict';
// Runs only in the private one-shot operator container. Host actions travel over
// its private stdin/stdout pipe; no Docker socket or control listener is exposed.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function healthJson(response) {
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw fail('REALTIME_HEALTH_OVER_BOUND');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
}
async function atomic(file, bytes) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw fail('PLACEMENT_PRIVATE_FILE_REQUIRED');
  const temporary = path.join(path.dirname(file), '.route-' + crypto.randomBytes(12).toString('hex'));
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
async function eligibleReady({ before, candidate, registry, activity, fetchImpl = fetch, timeoutMs = 60000 }) {
  const placement = require('../../lib/realtime-placement');
  const changed = candidate.owners.map((id, index) => {
    const old = before.workers.find(worker => worker.id === before.owners[index]);
    const next = candidate.workers.find(worker => worker.id === id);
    return old?.id !== next?.id || old?.incarnation !== next?.incarnation;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const revision = await registry.revision(), tenants = [];
    let after = null;
    for (;;) {
      const page = await registry.page(after, Math.min(1000, 10001 - tenants.length));
      if (page.revision !== revision) throw fail('REALTIME_PLACEMENT_REGISTRY_CHANGED');
      tenants.push(...page.tenants);
      if (tenants.length > 10000) throw fail('REALTIME_PLACEMENT_OVER_BOUND');
      if (page.tenants.length < 1000) break;
      after = page.tenants.at(-1);
    }
    const required = new Map(candidate.workers.map(worker => [worker.id, []]));
    for (const tenant of tenants) {
      const shard = placement.shard(tenant, candidate.shardCount);
      if (!changed[shard]) continue;
      const state = await activity.read(tenant);
      if (!state || !['active','paused','suspended'].includes(state.state)) throw fail('ACTIVITY_UNAVAILABLE');
      if (state.state === 'active') {
        const owner = candidate.owners[shard];
        if (owner === null) throw fail('REALTIME_PLACEMENT_UNAVAILABLE');
        required.get(owner).push(tenant);
      }
    }
    let ready = true;
    for (const worker of candidate.workers) {
      const prior = before.workers.find(row => row.id === worker.id);
      // Unchanged workers without newly assigned eligible tenants do not gate
      // this move on an unrelated cold/failed tenant.
      if (prior?.incarnation === worker.incarnation && required.get(worker.id).length === 0) continue;
      try {
        const response = await fetchImpl(worker.consumerOrigin + '/health', { signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now()))), redirect: 'error' });
        const health = await healthJson(response), p = health.placement;
        if (!p || p.generation !== candidate.generation || p.worker !== worker.id || p.incarnation !== worker.incarnation || !p.configured || p.resource !== true || !health.live || !Array.isArray(health.tenants)) throw fail('REALTIME_PLACEMENT_TARGET_UNREADY');
        const warm = new Set(health.tenants.filter(row => row.ready === true).map(row => row.tenant));
        if (required.get(worker.id).some(tenant => !warm.has(tenant))) ready = false;
      } catch { ready = false; }
    }
    if (ready && await registry.revision() === revision) return;
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  throw fail('REALTIME_PLACEMENT_TARGET_UNREADY');
}
async function run({ candidate, action, timeoutMs, authorityDigest, source = process.env }) {
  const { Client } = require('pg');
  const connectionString = source.NS_PLACEMENT_PG;
  if (!connectionString || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) throw fail('PLACEMENT_OPERATOR_INPUT_REQUIRED');
  const authority = require('./placement-authority').verify('/run/ns-config/env.json', source.NS_SOURCE_COMMIT, authorityDigest);
  if (authority.sha256 !== authorityDigest || authority.values.NS_PLACEMENT_PG !== connectionString || authority.values.NS_ACTIVITY_PG !== source.NS_ACTIVITY_PG) throw fail('PLACEMENT_AUTHORITY_REFUSED');
  const layout = require('./config').layout();
  const internal = require('../../lib/server/internal-api/listener-config').observer(source);
  const backendFile = '/run/ns-placement/backend.json', routesFile = '/run/ns-placement/routes.json';
  const before = JSON.parse(await fs.readFile(backendFile, 'utf8'));
  require('../../lib/storage/tenant-scope').setTenancyMode('multi');
  let registryConnection, activity;
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  try {
    registryConnection = await require('../../lib/storage/postgres-connection')({ connectionString, max: 1, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
    const registry = require('../../lib/tenant-registry/postgres').create({ connection: registryConnection, namespace: layout.namespaces.registry });
    activity = await require('../../lib/tenant-activity/postgres').create({ connectionString: authority.values.NS_ACTIVITY_PG, namespace: layout.namespaces.control, capability: 'reader' });
    await client.connect();
    return await require('../../lib/realtime-placement/publish').publish({ file: backendFile, candidate, internal, client,
      controlNamespace: layout.namespaces.control, registry,
      confirmStopped: owner => action('confirm', owner), stopOwners: owner => action('stop', owner),
      afterAssignment: async () => {
        await action('activate', {});
        await eligibleReady({ before, candidate, registry, activity, timeoutMs });
        // Read back the authoritative fsynced bytes. Never construct a second
        // placement or silently restore an older assignment after a failure.
        const bytes = await fs.readFile(backendFile);
        if (bytes.length > 1048576 || JSON.stringify(JSON.parse(bytes.toString())) !== JSON.stringify(candidate)) throw fail('REALTIME_PLACEMENT_REVISION_REFUSED');
        await atomic(routesFile, bytes);
      } });
  } finally { await client.end().catch(() => {}); await activity?.close().catch(() => {}); await registryConnection?.end().catch(() => {}); }
}
async function main() {
  const readline = require('node:readline');
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = input[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || first.value.length > 1048576) throw fail('PLACEMENT_OPERATOR_INPUT_REQUIRED');
  const request = JSON.parse(first.value);
  let sequence = 0;
  const action = async (name, owner) => {
    const id = ++sequence;
    process.stdout.write(JSON.stringify({ kind: 'placement-action', id, name, owner }) + '\n');
    const line = await iterator.next();
    if (line.done || line.value.length > 1024) throw fail('PLACEMENT_PLATFORM_UNAVAILABLE');
    const reply = JSON.parse(line.value);
    if (reply.id !== id || typeof reply.ok !== 'boolean') throw fail('PLACEMENT_PLATFORM_UNAVAILABLE');
    if (name !== 'confirm' && !reply.ok) throw fail('PLACEMENT_PLATFORM_UNAVAILABLE');
    return reply.ok;
  };
  try { const result = await run({ ...request, action }); process.stdout.write(JSON.stringify({ kind: 'placement-complete', ...result }) + '\n'); }
  finally { input.close(); }
}
if (require.main === module) main().catch(error => { process.stderr.write((/^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'PLACEMENT_CONTROL_FAILED') + '\n'); process.exitCode = 1; });
module.exports = { atomic, eligibleReady, run };
