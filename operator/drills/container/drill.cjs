'use strict';

// In-container driver for the synthetic recovery drills. It is mounted read-only into the binding's
// private `demo` operator service; it is not part of the image. It uses the shipping operator module
// (deploy/multitenant/restore.js) and the demonstration API client (demo.js) unchanged, and adds only
// phase holds, so the host can stop a process at a known point of a restore. It never clears a
// suspension, an unfinished operation or an audit row, and never retries a refused restore.
//
// Bookkeeping lives in NS_DRILL_STATE (a private host directory): expectations, hold and release
// markers. It holds synthetic identifiers and values only; no credential is written there.
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const app = process.cwd();
const operator = require(path.join(app, 'deploy/multitenant/restore.js'));
const demo = require(path.join(app, 'deploy/multitenant/demo.js'));
const artifacts = require(path.join(app, 'lib/tenant-lifecycle/filesystem-artifact'));
const directory = process.env.NS_DRILL_STATE || '/run/ns-drill-state';
const ARTIFACTS = '/run/ns-artifacts';
const fail = code => Object.assign(new Error(code), { code });
const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const file = (name, suffix) => path.join(directory, name + suffix);
const save = (name, suffix, value) => fs.writeFileSync(file(name, suffix), JSON.stringify(value) + '\n', { mode: 0o600 });
const load = (name, suffix) => JSON.parse(fs.readFileSync(file(name, suffix), 'utf8'));
const code = error => /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : (/^[A-Z][A-Z0-9_]{1,100}$/.test(error?.message || '') ? error.message : 'DRILL_FAILED');

function context () {
  if (process.env.NS_DEMO_CONFIRM_SYNTHETIC !== '1') throw fail('DRILL_SYNTHETIC_CONFIRMATION_REQUIRED');
  const config = operator.loadConfig(), [a, b] = config.tenants;
  const api = (tenant, route, options = {}) => demo.request(config, tenant, route, options);
  const write = (tenant, id, value) => api(tenant, '/api/v3/entries/' + id, { method: 'PUT', body: value });
  const read = async (tenant, id) => (await api(tenant, '/api/v3/entries/' + id)).result;
  return { config, a, b, api, write, read };
}

// Known rows on A and B, an export of A, then a change to A the restore must undo.
async function seed (name) {
  const { config, a, b, api, write, read } = context(), date = Date.now();
  const ids = { kept: randomUUID(), extra: randomUUID(), b: randomUUID() };
  await write(a, ids.kept, demo.document(ids.kept, date - 3000, 123));
  await write(b, ids.b, demo.document(ids.b, date - 2000, 151));
  const original = await read(a, ids.kept), rowB = await read(b, ids.b);
  const artifact = await operator.capture(config, a.id);
  await artifacts.saveTenantArtifact(artifact, { directory: ARTIFACTS });
  await api(a, '/api/v3/entries/' + ids.kept, { method: 'PATCH', body: { sgv: 234 } });
  await write(a, ids.extra, demo.document(ids.extra, date - 1000, 145));
  const changed = await read(a, ids.kept), added = await read(a, ids.extra);
  if (changed.sgv !== 234 || added.sgv !== 145) throw fail('DRILL_SEED_NOT_OBSERVED');
  const expectation = { version: 1, tenant: a.id, other: b.id, ids, digest: artifact.digest, date,
    cursor: Math.max(changed.srvModified, added.srvModified), original: { sgv: original.sgv, date: original.date },
    b: { sgv: rowB.sgv, srvModified: rowB.srvModified } };
  save(name, '.expect.json', expectation);
  return { step: 'seed', tenant: a.id, digest: artifact.digest, cursor: expectation.cursor };
}

async function hold (name, phase, ms) {
  save(name, '.hold-' + phase, { at: Date.now() });
  const deadline = Date.now() + ms;
  while (!fs.existsSync(file(name, '.release'))) {
    if (Date.now() >= deadline) throw fail('DRILL_HOLD_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// The shipping restore, optionally held inside the data transaction (`row`: suspension is
// committed, restored rows are not) or after the data commit and before the participants'
// invalidation acknowledgements (`committed`).
async function restore (name, options) {
  const { config } = context(), expectation = load(name, '.expect.json');
  const digest = options['--digest'] || expectation.digest;
  const artifact = await artifacts.loadTenantArtifact({ directory: ARTIFACTS, digest });
  const phase = options['--hold'], ms = Number(options['--hold-ms'] || 60000);
  if (phase && !['row', 'committed'].includes(phase) || !Number.isSafeInteger(ms) || ms < 1 || ms > 600000) throw fail('DRILL_USAGE');
  let held = false;
  const summary = await operator.restore(config, artifact, process.env, {
    ...(phase === 'row' ? { onRow: async () => { if (!held) { held = true; await hold(name, 'row', ms); } } } : {}),
    onCommitted: async () => { save(name, '.data-committed', { at: Date.now() }); if (phase === 'committed') await hold(name, 'committed', ms); }
  });
  return { step: 'restore', state: summary.state, generation: summary.generation, mode: summary.result?.mode,
    replaced: summary.result?.replaced, deleted: summary.result?.deleted };
}

// State: the restored tenant's rows read back through the API by identifier.
async function verifyState (name, options) {
  const { a, read } = context(), e = load(name, '.expect.json'), want = options['--expect'] || 'restored';
  if (!['restored', 'changed'].includes(want)) throw fail('DRILL_USAGE');
  const kept = await read(a, e.ids.kept);
  let extraPresent = true;
  try { const row = await read(a, e.ids.extra); extraPresent = !!row && row.isValid !== false; } catch { extraPresent = false; }
  const observed = { keptValue: kept.sgv, keptDate: kept.date === e.original.date, extraPresent, forward: kept.srvModified > e.cursor };
  const pass = want === 'restored' ? kept.sgv === e.original.sgv && observed.keptDate && !extraPresent && observed.forward
    : kept.sgv === 234 && extraPresent;
  if (!pass) throw Object.assign(fail('DRILL_STATE_MISMATCH'), { observed });
  return { step: 'verify-state', expect: want, pass, observed };
}

// History: an incremental client that saw the changed rows converges from the history reply alone.
async function verifyHistory (name) {
  const { a, api } = context(), e = load(name, '.expect.json');
  const history = (await api(a, '/api/v3/entries/history/' + e.cursor + '?limit=1000')).result;
  if (!Array.isArray(history)) throw fail('DRILL_HISTORY_SHAPE');
  const correction = history.find(row => row.identifier === e.ids.kept), deletion = history.find(row => row.identifier === e.ids.extra);
  const observed = { rows: history.length, correction: correction?.sgv === e.original.sgv && correction.srvModified > e.cursor,
    deletion: deletion?.isValid === false && deletion.srvModified > e.cursor };
  if (!observed.correction || !observed.deletion) throw Object.assign(fail('DRILL_HISTORY_MISMATCH'), { observed });
  return { step: 'verify-history', pass: true, observed };
}

// One admitted read per tenant; a refusal is reported as its code, never retried.
async function probe (name, options) {
  const { a, b, read } = context(), e = load(name, '.expect.json'), which = options['--tenant'];
  if (!['a', 'b'].includes(which)) throw fail('DRILL_USAGE');
  try { const row = await read(which === 'a' ? a : b, which === 'a' ? e.ids.kept : e.ids.b); return { step: 'probe', tenant: which, admitted: true, value: row.sgv }; }
  catch (error) { return { step: 'probe', tenant: which, admitted: false, refusal: code(error) }; }
}

// The other tenant completes a new write and reads it back, and its earlier row is unchanged.
async function progress (name) {
  const { b, write, read } = context(), e = load(name, '.expect.json'), id = randomUUID();
  await write(b, id, demo.document(id, Date.now(), 152));
  const row = await read(b, id), earlier = await read(b, e.ids.b);
  if (row.sgv !== 152 || earlier.sgv !== e.b.sgv || earlier.srvModified !== e.b.srvModified) throw fail('DRILL_OTHER_TENANT_MISMATCH');
  return { step: 'other-tenant-progress', pass: true, wrote: id };
}

// History as an incremental client reads it from the beginning, reduced to a digest per tenant.
async function historyDigest () {
  const { a, b, api } = context(), out = {};
  for (const [key, tenant] of [['a', a], ['b', b]]) {
    const rows = (await api(tenant, '/api/v3/entries/history/1000000000000?limit=1000')).result;
    if (!Array.isArray(rows)) throw fail('DRILL_HISTORY_SHAPE');
    const reduced = rows.map(row => [row.identifier, row.srvModified, row.isValid !== false, row.sgv ?? null]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    out[key] = { rows: rows.length, digest: require('node:crypto').createHash('sha256').update(JSON.stringify(reduced)).digest('hex') };
  }
  return { step: 'history-digest', ...out };
}

// Is one identifier present for a tenant? A refusal (including not found) reads as absent.
async function lookup (name, options) {
  const { a, b, read } = context(), which = options['--tenant'], id = options['--id'];
  if (!['a', 'b'].includes(which) || !/^[0-9a-f-]{36}$/.test(id || '')) throw fail('DRILL_USAGE');
  try { const row = await read(which === 'a' ? a : b, id); return { step: 'lookup', present: !!row && row.isValid !== false }; }
  catch { return { step: 'lookup', present: false }; }
}

// Sustained concurrent writes on one tenant, so a role can be killed with requests in flight.
async function churn (name, options) {
  const { a, b, write } = context(), tenant = options['--tenant'] === 'b' ? b : a, total = Number(options['--count'] || 400);
  if (!Number.isSafeInteger(total) || total < 1 || total > 5000) throw fail('DRILL_USAGE');
  let done = 0, refused = 0; save(name, '.churn-started', { at: Date.now() });
  for (let i = 0; i < total; i += 20) {
    await Promise.all(Array.from({ length: Math.min(20, total - i) }, async () => {
      const id = randomUUID(); try { await write(tenant, id, demo.document(id, Date.now(), 111)); done++; } catch { refused++; }
    }));
  }
  return { step: 'churn', done, refused };
}

// Export only, optionally held before the artifact is published to the private directory.
async function exportOnly (name, options) {
  const { config, a } = context();
  const artifact = await operator.capture(config, a.id);
  if (options['--hold'] === 'captured') await hold(name, 'captured', Number(options['--hold-ms'] || 60000));
  await artifacts.saveTenantArtifact(artifact, { directory: ARTIFACTS });
  const reloaded = await artifacts.loadTenantArtifact({ directory: ARTIFACTS, digest: artifact.digest });
  return { step: 'export', digest: reloaded.digest };
}

async function main (args) {
  const command = args.shift(), name = args.shift(), options = {};
  if (!NAME.test(name || '')) throw fail('DRILL_USAGE');
  while (args.length) { const key = args.shift(), value = args.shift(); if (!/^--[a-z-]+$/.test(key || '') || !value) throw fail('DRILL_USAGE'); options[key] = value; }
  const commands = { seed, restore, 'verify-state': verifyState, 'verify-history': verifyHistory, probe, progress, export: exportOnly, 'history-digest': historyDigest, lookup, churn };
  if (!Object.hasOwn(commands, command)) throw fail('DRILL_USAGE');
  return commands[command](name, options);
}

main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'), error => {
  // Codes only: inherited HTTP/PostgreSQL errors can carry a credential-bearing URL.
  process.stdout.write(JSON.stringify({ error: code(error), ...(error.observed ? { observed: error.observed } : {}),
    ...(error.cause ? { cause: code(error.cause) } : {}) }) + '\n');
  process.exitCode = 1;
});
