'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const workers = require('./evaluator-workers');
test('opt-in evaluator processes require an explicit bounded count and allow idle registry slices', () => {
  assert.equal(workers.selection({}), null);
  for (const raw of ['0', '33', '64', '2x', '', 2]) assert.throws(() => workers.selection({NS_EVALUATOR_WORKERS:raw}));
  assert.deepEqual(workers.services(workers.selection({NS_EVALUATOR_WORKERS:'3'})), ['evaluator','evaluator-2','evaluator-3']);
  assert.equal(workers.MAX_WORKERS, 32);
  for (const raw of ['9', '20', '32']) assert.equal(workers.selection({NS_EVALUATOR_WORKERS:raw}).workers, Number(raw));
});

test('selected evaluator processes take their ordinal from their hostname and K from NS_EVALUATOR_SLICES',()=>{
  const one=workers.compose({workers:1},'compose.yaml');
  assert(!/NS_EVALUATOR_SLICES|hostname:|NS_PGSTREAM_EVALUATOR_SLICE|NS_PGSTREAM_RECEIVER_URL/.test(one),'K=1 is the unsliced single evaluator');
  assert.deepEqual(workers.roster({workers:1}).map(r=>r.alias),['evaluator']);
  const text=workers.compose({workers:3},'compose.yaml');
  assert(!/NS_PGSTREAM_EVALUATOR_SLICE|NS_PGSTREAM_RECEIVER_URL/.test(text),'no slice JSON in the environment');
  assert.equal((text.match(/NS_EVALUATOR_SLICES: "3"/g)||[]).length,3);
  for(const [i,row] of workers.roster({workers:3}).entries()){
    assert.equal(row.alias,'evaluator-'+i+'.evaluator');
    assert(text.includes('    hostname: evaluator-'+i+'\n'));
    assert(text.includes('aliases: [evaluator-'+i+'.evaluator]'));
    assert(text.includes(row.socket));
  }
});

test('evaluator and realtime counts are selected independently; every sender gets both rosters', () => {
  const { roles } = require('./prepare');
  for (const [ev, rt] of [['9', '2'], ['32', '8'], ['2', '4'], ['20', '1']]) {
    const selected = roles({ NS_EVALUATOR_WORKERS: ev, NS_REALTIME_WORKERS: rt });
    assert.deepEqual([selected.evaluator.workers, selected.realtime.workers], [Number(ev), Number(rt)]);
    const overlay = JSON.parse(require('./writer-driven').compose(2, selected.evaluator, selected.realtime)).services;
    const evaluators = workers.services(selected.evaluator), reals = require('./realtime-workers').services(selected.realtime).filter(name => name !== 'socket-edge');
    assert.deepEqual([evaluators.length, reals.length], [Number(ev), Number(rt)]);
    for (const name of ['api', 'api-2', 'tenant-admin', ...evaluators, ...reals]) {
      assert.equal(overlay[name].environment.NS_EVALUATOR_SLICES, ev, name);
      assert.equal(overlay[name].environment.NS_REALTIME_SLICES, rt, name);
    }
    for (const [ordinal, name] of evaluators.entries()) {
      assert.equal(overlay[name].hostname, 'evaluator-' + ordinal);
      assert.deepEqual(JSON.parse(overlay[name].environment.NS_REALTIME_SLICE_PEERS), reals.map((_, i) => ({ url: 'http://realtime-' + i + '.realtime-peers:19003/' })));
    }
    for (const [ordinal, name] of reals.entries()) assert.equal(overlay[name].hostname, 'realtime-' + ordinal);
  }
  assert.deepEqual(roles({}), { realtime: null, evaluator: null });
  // Each role keeps its own bound.
  assert.throws(() => roles({ NS_EVALUATOR_WORKERS: '9', NS_REALTIME_WORKERS: '9' }), /NS_REALTIME_WORKERS must be explicit 1..8/);
  assert.throws(() => roles({ NS_EVALUATOR_WORKERS: '33', NS_REALTIME_WORKERS: '8' }), /NS_EVALUATOR_WORKERS must be explicit 1..32/);
});
