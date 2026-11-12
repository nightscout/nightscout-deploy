'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const workers = require('./realtime-workers');
const operator = require('./replace-realtime');
test('replacement retains logical partition and durable routing identity while rotating the exact stopped boot', () => {
  const before = workers.initial({ workers: 2, shards: 8 });
  const next = operator.replacement(before, 'realtime-1');
  assert.equal(next.generation, 2); assert.equal(next.shardCount, before.shardCount);
  assert.deepEqual(next.owners, before.owners);
  assert.notEqual(next.workers[0].incarnation, before.workers[0].incarnation);
  assert.equal(next.workers[1].incarnation, before.workers[1].incarnation);
  assert.deepEqual(next.transition.stopped, [{ worker: 'realtime-1', incarnation: before.workers[0].incarnation }]);
  const move = operator.replacement(before, 'realtime-1', { shard: '0', to: 'realtime-2' });
  assert.equal(move.owners[0], 'realtime-2');
  assert.deepEqual(move.owners.slice(1), before.owners.slice(1));
  assert.throws(() => operator.replacement(before, 'realtime-1', { shard: '1', to: 'realtime-2' }));
  assert.throws(() => operator.replacement(before, 'missing'));
});
test('operator CLI requires exact owned project/state/roster and bounds the move deadline', () => {
  const base = ['--project','ns-owned-test','--state','/tmp/private-state','--compose','/tmp/compose.yaml','--worker','realtime-1'];
  assert.equal(operator.argumentsFor(base).timeout, 60000);
  assert.equal(operator.argumentsFor([...base,'--recover']).recover,true);
  assert.throws(()=>operator.argumentsFor([...base,'--recover','--recover']));
  assert.throws(()=>operator.argumentsFor([...base,'--recover','--shard','0','--to','realtime-2']));
  for (const extra of [['--timeout','900001'], ['--shard','0'], ['--to','realtime-2'], ['--worker','realtime-2'], ['--unknown','value']]) assert.throws(() => operator.argumentsFor([...base,...extra]));
  assert.equal(operator.argumentsFor([...base,'--shard','0','--to','realtime-2']).to, 'realtime-2');
});
test('private boot identity replacement rejects symlinks and broad files and persists complete JSON atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ns-placement-private-')), file = path.join(dir,'env.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ boot: 'old' }), { mode: 0o600 });
    operator.atomicJson(file, { boot: 'new' }); assert.deepEqual(operator.privateJson(file), { boot: 'new' });
    fs.chmodSync(file, 0o644); assert.throws(() => operator.atomicJson(file, { boot: 'wrong' }));
    fs.chmodSync(file, 0o600); fs.symlinkSync(file, path.join(dir,'link')); assert.throws(() => operator.privateJson(path.join(dir,'link')));
    assert.deepEqual(fs.readdirSync(dir).sort(), ['env.json','link']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
