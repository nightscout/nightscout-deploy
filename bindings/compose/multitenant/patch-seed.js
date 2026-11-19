'use strict';

// Runs only in the stopped fixture's bootstrap job, with its dedicated DBA
// connection. The generated native selection binds this seed to its WAL source.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { privateWrite } = require('./prime');
const plan = require('./config');
const refuse = message => { throw Object.assign(new Error(message), { code: message }); };
const pair = (sourceCommit, deployCommit) => ({ sourceCommit, deployCommit });

async function migrateCatalogues(layout, catalogues, migrate) {
  const steps = [];
  // Inspect every installed ledger before applying the first append.
  for (const [kind, catalogue] of Object.entries(catalogues)) {
    const input = { namespace: layout.namespaces[kind], catalogue };
    const status = await migrate('status', input);
    if (!status.applied.length) refuse('SEED_PATCH_COMMISSIONED_LEDGER_REQUIRED');
    steps.push({ input, pending: status.pending });
  }
  const applied = [];
  for (const { input, pending } of steps) {
    if (pending.length) applied.push(...(await migrate('up', input)).done);
    await migrate('check', input);
  }
  return { catalogues: steps.length, applied };
}

async function patch(options, complete, previous, finish = false) {
  const target = pair(options.sourceCommit, options.deployCommit);
  const from = pair(...previous);
  if (complete.version !== 2 || !complete.registryMode ||
      (complete.patch ? !isDeepStrictEqual(complete.patch, { from, target }) :
        finish || !isDeepStrictEqual(pair(complete.sourceCommit, complete.deployCommit), from))) {
    refuse('SEED_PATCH_REVISION_MISMATCH');
  }
  const file = name => path.join(options.output, name);
  const read = name => JSON.parse(fs.readFileSync(file(name), 'utf8'));
  const primed = read('primer/primed.json');
  const layout = plan.layout();
  if (primed.state !== 'synthetic-data-primed' || !Number.isSafeInteger(primed.tenants) || primed.tenants < 1 ||
      !isDeepStrictEqual(layout, read('bootstrap/layout.json'))) refuse('SEED_PATCH_COMMISSIONED_LAYOUT_REQUIRED');
  const ops = read('ops/config.json'), evaluator = read('evaluator/config.json');
  const native = require('../../lib/tenant-lifecycle/native-selection');
  const selected = native.create(ops.nativeSelection);
  native.bind(selected, layout.namespaces.control);
  const client = new (require('pg').Client)({ connectionString: options.pg.href, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  await client.connect();
  try {
    const live = await require('./native-lifecycle').source(client, evaluator.pgstream.slot);
    await native.assertCurrent(client, selected, { nativeSource: { source: live, generation: evaluator.pgstream.generation } });
    if (finish) {
      // Structural verification can issue a different API contract. A fixture
      // needing tenant backfill must remain offline until its floors match.
      const ns = plan.quote(layout.prefix + '_platform_verification');
      const { rows } = await client.query(`SELECT count(*)::int AS tenants, count(*) FILTER (WHERE
        f.status='verified' AND f.generation=w.generation AND f.epoch=c.epoch
        AND r.status='verified' AND r.epoch=c.epoch AND f.contract_digest=r.contract_digest)::int AS current
        FROM ${plan.quote(layout.namespaces.registry)}.tenant_registry t
        LEFT JOIN ${plan.quote(layout.namespaces.control)}.tenant_lifecycle_windows w USING (tenant_id)
        LEFT JOIN ${ns}.verified_tenant_floor f USING (tenant_id)
        LEFT JOIN ${ns}.verification_control c ON c.singleton
        LEFT JOIN ${ns}.verified_role r ON r.role='api'`);
      if (rows[0].tenants < primed.tenants || rows[0].current !== rows[0].tenants) refuse('SEED_PATCH_TENANT_FLOOR_BACKFILL_REQUIRED');
      const { patch: pending, ...original } = complete;
      privateWrite(file('bootstrap/complete.json'), { ...original, ...target });
      return { state: 'seed-verified', tenants: rows[0].tenants, ...target };
    }

    const lifecycle = plan.lifecycle(layout);
    if (!isDeepStrictEqual(lifecycle.namespaces, ops.namespaces)) refuse('SEED_PATCH_NAMESPACE_CHANGE');
    const config = read('admin/verification/evaluator.config.json');
    const env = read('admin/verification/evaluator.env.json');
    const parsed = require('../../lib/server/serve/evaluator-config').parse(config, env,
      require('../../lib/server/internal-api/listener-config').resolve(['evaluator'], env));
    const evaluatorProof = require('../../lib/server/serve/platform-verification').contractInputs(parsed, 'evaluator');

    // Older bootstraps also refuse the null pair. A failed/partial transition
    // can only continue with the original source and selected target.
    if (!complete.patch) privateWrite(file('bootstrap/complete.json'),
      { ...complete, ...pair(null, null), patch: { from, target } });
    const runner = require('../../lib/migrations/postgres');
    const result = await migrateCatalogues(layout, plan.catalogues({ nativeSelection: selected }),
      (action, input) => runner.run(action, { ...input, direct: true, connectionString: options.pg.href }));
    await require('./platform-startup').upgrade(client, layout);
    privateWrite(file('ops/config.json'), { ...ops, ...lifecycle, evaluatorProof });
    privateWrite(file('ops/env.json'), { ...read('ops/env.json'), NS_SOURCE_COMMIT: target.sourceCommit });
    return { state: 'seed-migrated', ...result, ...target };
  } finally { await client.end(); }
}

module.exports = { patch, migrateCatalogues };
