'use strict';
// Independent physical/durable completion oracle; cross-revision cache identity
// and process generations may change. No SQL writes, input counter or TIME gate.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { wait } = require('./pgstream-recovery.cjs');
function qualify(rows, expected) {
  assert.deepEqual(rows.map(r => r.tenant).sort(), expected.map(r => r.tenant).sort(), 'EXACT_TENANT_COHORT');
  for (const row of rows) {
    const wanted = expected.find(x => x.tenant === row.tenant);
    assert.deepEqual(row.work_observed, row.work_completed, 'ACCEPTED_WORK_COMPLETED');
    assert.equal(row.work_pending_at, null, 'NO_LOST_PENDING_WORK');
    for (const [index, key] of [[0, 'last_stamp'], [1, 'settings'], [2, 'policy'], [3, 'activity']]) assert.equal(String(row.work_completed[index]), String(row[key]), 'CURRENT_PHYSICAL_' + key);
    assert.equal(String(row.input_checkpoint), String(row.last_stamp), 'CURRENT_ACCEPTED_INPUT');
    assert.equal(String(row.output_restore_generation), String(row.restore), 'CURRENT_RESTORE_AUTHORITY');
    assert.equal(row.phase, 'active');
    assert(row.input?.ready, 'READY_INPUT');
    assert(row.output?.frame.sgvs.some(x => x.mills === wanted.date && x.mgdl === wanted.value), 'INDEPENDENT_CURRENT_CONTENT');
  }
  return true;
}
async function main() {
  if (process.argv[2] === 'write') {
    assert.equal(process.env.NS_DEMO_CONFIRM_SYNTHETIC, '1');
    const file = '/run/ns-drill-state/pgstream-expect.json', expected = JSON.parse(fs.readFileSync(file));
    const root = process.cwd(), config = require(path.join(root, 'deploy/multitenant/restore')).loadConfig();
    const demo = require(path.join(root, 'deploy/multitenant/demo')), row = expected[1];
    const value = row.value === 177 ? 178 : 177;
    await demo.request(config, config.tenants.find(t => t.id === row.tenant), '/api/v3/entries/' + row.id, { method: 'PATCH', body: { sgv: value } });
    row.value = value; fs.writeFileSync(file, JSON.stringify(expected), { mode: 0o600 });
    return { state: 'post-transition-new-input' };
  }
  const project = process.env.NS_DRILL_PROJECT, core = process.env.NS_DRILL_CORE;
  assert(/^recovery-drills-[a-z0-9-]+$/.test(project || ''));
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  const ids = docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]).trim().split(/\s+/).filter(Boolean);
  const all = JSON.parse(docker(['inspect', ...ids]));
  const pg = all.find(r => r.Config.Labels['com.docker.compose.service'] === 'postgres');
  assert(pg);
  const state = fs.readFileSync(path.join(core, 'deploy/multitenant/.env'), 'utf8').split('\n').find(x => x.startsWith('NS_DEMO_STATE=')).slice('NS_DEMO_STATE='.length);
  const expected = JSON.parse(fs.readFileSync(path.join(state, 'drill/pgstream-expect.json')));
  let last;
  try { await wait(() => {
    const sql = `SELECT c.tenant_id::text AS tenant,c.work_observed,c.work_completed,c.work_pending_at,c.work_due_at,c.work_completed_at,c.output_restore_generation,c.projection->0->'output' AS output,i.checkpoint AS input_checkpoint,i.projection->0 AS input,w.last_stamp,s.version AS settings,p.generation AS policy,a.version AS activity,l.generation AS restore,l.phase FROM nsdemo_eval_checkpoint.tenant_consumer_checkpoint c JOIN nsdemo_eval_checkpoint.tenant_consumer_checkpoint i ON i.tenant_id=c.tenant_id AND i.consumer='evaluator-compose-demo' JOIN nsdemo_clock.tenant_write_clock w ON w.tenant_id=c.tenant_id JOIN nsdemo_display_settings.tenant_settings s ON s.tenant_id=c.tenant_id JOIN nsdemo_operator_policy.tenant_operator_policy p ON p.tenant_id=c.tenant_id JOIN nsdemo_control.tenant_activity a ON a.tenant_id=c.tenant_id JOIN nsdemo_control.tenant_lifecycle_windows l ON l.tenant_id=c.tenant_id WHERE c.consumer='evaluator-compose-demo-completed' ORDER BY c.tenant_id`;
    last = JSON.parse(execFileSync('docker', ['exec', '-i', pg.Id, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'nightscout_compose_test'], { input: "BEGIN READ ONLY; SELECT coalesce(json_agg(x),'[]') FROM (" + sql + ') x; COMMIT;', encoding: 'utf8', timeout: 10000 }));
    return qualify(last, expected);
  }, 'REVISION_CURRENT_WORK_NOT_PROVEN'); }
  finally { if (last) fs.writeFileSync(path.join(state, 'drill', 'revision-observation-' + Date.now() + '.json'), JSON.stringify(last) + '\n', { flag: 'wx', mode: 0o600 }); }
  const file = path.join(state, 'drill', 'revision-' + Date.now() + '.json');
  fs.writeFileSync(file, JSON.stringify(last) + '\n', { flag: 'wx', mode: 0o600 });
  return { state: 'current-two-tenant-physical-input-completed-content', evidence: file };
}
if (require.main === module) main().then(x => console.log(JSON.stringify(x)), e => { console.error(JSON.stringify({ error: e.code || 'REVISION_DRILL_FAILED' })); process.exitCode = 1; });
module.exports = { qualify };
