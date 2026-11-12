'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const workers = require('./realtime-workers'), operator = require('./replace-realtime');
test('route publication waits for actual eligible target readiness and preserves unrelated failed-shard independence', async () => {
  const core = process.env.NS_UI_TEST_CORE; assert.ok(core, 'Explicit joined source required');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'ns-placement-readiness-'));
  fs.symlinkSync(path.join(core,'lib'),path.join(scratch,'lib'),'dir');
  const dir = path.join(scratch,'deploy/multitenant'); fs.mkdirSync(dir,{recursive:true});
  fs.copyFileSync(path.join(__dirname,'placement-control.js'),path.join(dir,'placement-control.js'));
  const { eligibleReady, atomic } = require(path.join(dir,'placement-control.js'));
  try {
    const before = workers.initial({ workers: 2, shards: 8 }), candidate = operator.replacement(before,'realtime-1');
    const shard = require(core + '/lib/realtime-placement').shard;
    let tenant;
    for (let i=1; i<100; i++) { const id = '11111111-1111-4111-8111-' + i.toString(16).padStart(12,'0'); if (candidate.owners[shard(id,8)] === 'realtime-1') { tenant=id;break; } }
    assert.ok(tenant);
    const registry = { revision: async () => '1', page: async () => ({ revision: '1', tenants: [tenant] }) };
    let active = true, warm = false, generation = 2, calls = 0;
    const activity = { read: async () => active === null ? null : { state: active ? 'active' : 'paused' } };
    const fetchImpl = async origin => {
      calls++;
      assert.equal(new URL(origin).hostname,'realtime','unrelated failed worker is not queried');
      const worker = candidate.workers[0];
      return new Response(JSON.stringify({ live: true, ready: true, placement: { configured: true, resource: true, generation, worker: worker.id, incarnation: worker.incarnation }, tenants: warm ? [{ tenant, ready: true }] : [] }));
    };
    await assert.rejects(eligibleReady({ before,candidate,registry,activity,fetchImpl,timeoutMs:10 }), /TARGET_UNREADY/);
    warm = true; await eligibleReady({ before,candidate,registry,activity,fetchImpl,timeoutMs:100 });
    generation = 1; await assert.rejects(eligibleReady({ before,candidate,registry,activity,fetchImpl,timeoutMs:10 }), /TARGET_UNREADY/);
    generation = 2; active = false; warm = false; await eligibleReady({ before,candidate,registry,activity,fetchImpl,timeoutMs:100 });
    active = null; await assert.rejects(eligibleReady({ before,candidate,registry,activity,fetchImpl,timeoutMs:100 }), /ACTIVITY_UNAVAILABLE/);
    assert.ok(calls >= 4);
    const file = path.join(scratch,'routes.json'); fs.writeFileSync(file,'old',{mode:0o600});
    await atomic(file,Buffer.from(JSON.stringify(candidate))); assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),candidate);
    assert.equal(fs.statSync(file).mode & 0o077,0);
  } finally { fs.rmSync(scratch,{recursive:true,force:true}); }
});
