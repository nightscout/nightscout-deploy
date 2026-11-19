'use strict';

// Host checks for the drill tooling's refusals. No Docker call is reached: every case stops at
// a guard. Run: node --test operator/drills/guards.test.js
// NS_DRILL_GUARD_DIR points the test at another copy of the scripts (used for the control).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const here = process.env.NS_DRILL_GUARD_DIR || __dirname;

function deployment () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-drill-guards-'));
  const folder = path.join(root, 'core/deploy/multitenant'), state = path.join(root, 'state');
  fs.mkdirSync(folder, { recursive: true }); fs.mkdirSync(state, { mode: 0o700 });
  fs.writeFileSync(path.join(folder, '.env'), 'NS_DEMO_STATE=' + state + '\nNS_DEMO_PORT=18999\n');
  return { root, state, env: { PATH: process.env.PATH, NS_DRILL_CORE: path.join(root, 'core'), NS_DRILL_PROJECT: 'recovery-drills-guard-test', NS_DRILL_IMAGE: 'unused:local' } };
}
const run = (script, args, env) => spawnSync(path.join(here, script), args, { env, encoding: 'utf8', timeout: 20000 });

test('every script parses', () => {
  for (const name of fs.readdirSync(here).filter(name => name.endsWith('.sh'))) assert.equal(spawnSync('bash', ['-n', path.join(here, name)]).status, 0, name);
  for (const name of fs.readdirSync(path.join(here, 'container'))) assert.equal(spawnSync(process.execPath, ['--check', path.join(here, 'container', name)]).status, 0, name);
});

test('a project outside the drill prefix is refused before anything runs', () => {
  const d = deployment();
  for (const command of [['ps'], ['destroy', '--confirm-project', 'not-a-drill-project-guard-test'], ['compose', 'down', '--volumes']]) {
    const result = run('stack.sh', command, { ...d.env, NS_DRILL_PROJECT: 'not-a-drill-project-guard-test' });
    assert.equal(result.status, 64); assert.match(result.stderr, /DRILL_PROJECT_REFUSED/);
  }
  const restore = run('restore-deployment.sh', [d.root], { ...d.env, NS_DRILL_PROJECT: 'other' });
  assert.equal(restore.status, 64); assert.match(restore.stderr, /DRILL_PROJECT_REFUSED/);
});

test('destroy needs the project named again', () => {
  const d = deployment();
  for (const args of [['destroy'], ['destroy', '--confirm-project', 'recovery-drills-other'], ['destroy', 'recovery-drills-guard-test']]) {
    const result = run('stack.sh', args, d.env);
    assert.equal(result.status, 64); assert.match(result.stderr, /DRILL_DESTROY_CONFIRMATION_REQUIRED/);
  }
});

test('explicit subnets come as a pair', () => {
  const d = deployment();
  const result = run('stack.sh', ['state'], { ...d.env, NS_DRILL_BACKEND_SUBNET: '10.213.0.0/27' });
  assert.equal(result.status, 64); assert.match(result.stderr, /DRILL_SUBNET_REFUSED/);
});

test('whole-deployment recovery needs the loss accepted', () => {
  const d = deployment();
  const result = run('recover-from-backup.sh', [d.root], d.env);
  assert.equal(result.status, 64); assert.match(result.stderr, /RECOVERY_LOSS_NOT_ACCEPTED/);
  assert.equal(fs.existsSync(d.state), true);
});

test('a backup never lands on an existing or relative path', () => {
  const d = deployment();
  for (const target of [d.state, 'relative/backup']) {
    const result = run('backup.sh', [target], d.env);
    assert.equal(result.status, 64); assert.match(result.stderr, /BACKUP_TARGET_REFUSED/);
  }
});

test('a restore never overwrites an existing state directory', () => {
  const d = deployment(), backup = path.join(d.root, 'backup');
  fs.mkdirSync(backup); fs.writeFileSync(path.join(backup, 'manifest.json'), '{}');
  const result = run('restore-deployment.sh', [backup], d.env);
  assert.equal(result.status, 1); assert.match(result.stderr, /RESTORE_STATE_EXISTS/);
  const missing = run('restore-deployment.sh', [d.state], d.env);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /RESTORE_MANIFEST_MISSING/);
});

test('the pre-check takes a tenant identifier only', () => {
  const d = deployment();
  const result = run('precheck.sh', ["x'; SELECT 1; --"], d.env);
  assert.equal(result.status, 64); assert.match(result.stderr, /PRECHECK_USAGE/);
});

for (const [setting, code] of [
  ['NS_EVALUATOR_WORKERS=2', 'DRILL_SELECTED_PROFILE_UNSUPPORTED'],
  ['NS_REALTIME_WORKERS=2', 'DRILL_SELECTED_PROFILE_UNSUPPORTED'],
  ['NS_API_REPLICAS=2', 'DRILL_REPLICA_PROFILE_UNSUPPORTED'],
  ['NS_DEMO_PROJECT=recovery-drills-another', 'DRILL_PREPARED_PROJECT_CHANGED']
]) test('refuses unsupported recovery cohort before Docker: ' + setting, () => {
  const d = deployment();
  fs.appendFileSync(path.join(d.env.NS_DRILL_CORE, 'deploy/multitenant/.env'), setting + '\n');
  for (const action of ['up', 'roles-up', 'roles-restart']) {
    const result = run('stack.sh', [action], d.env);
    assert.equal(result.status, code === 'DRILL_PREPARED_PROJECT_CHANGED' ? 64 : 78);
    assert.match(result.stderr, new RegExp(code));
  }
});

test('ordinary up and restart include the independent stream and omit the retired feed reader', () => {
  const d=deployment(), bin=path.join(d.root,'bin'), folder=path.join(d.env.NS_DRILL_CORE,'deploy/multitenant'), log=path.join(d.root,'calls');
  fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'docker'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$DRILL_CALLS"\n',{mode:0o755});
  for(const name of ['build.js','publish-primer.js'])fs.writeFileSync(path.join(folder,name),'process.exit(0);');
  for(const action of ['up','roles-up','roles-restart']){
    fs.writeFileSync(log,'');const result=run('stack.sh',[action],{...d.env,PATH:bin+':'+d.env.PATH,DRILL_CALLS:log});assert.equal(result.status,0,result.stderr);
    const calls=fs.readFileSync(log,'utf8');assert(!calls.includes('feed-reader'),'retired service');
    assert.match(calls,/up -d .*realtime evaluator pgstream tenant-admin ui nginx/,'stream recovery cohort');
    if (action === 'up') {
      const stages = calls.trim().split('\n').map(line => line.split(' '));
      const index = name => stages.findIndex(args => args.includes(name));
      const serving = index('pgstream');
      assert.ok(index('deploy/multitenant/platform-verify.js') >= 0 && index('deploy/multitenant/platform-verify.js') < serving);
      assert.ok(serving < index('provision') && index('provision') < index('prime'));
    }
    if(action==='roles-restart')assert.match(calls,/stop nginx ui tenant-admin pgstream evaluator realtime api admin/,'old stream stopped before restart');
  }
});

const {qualify}=require('./container/pgstream-recovery.cjs');
function recovered(){
  const expected=[{tenant:'a',date:10,value:50},{tenant:'b',date:20,value:159}];
  const rows=expected.map(x=>({tenant:x.tenant,work_observed:[8,1,2,3],work_completed:[8,1,2,3],work_pending_at:null,work_due_at:null,work_completed_at:100,last_stamp:8,settings:1,policy:2,activity:3,restore:4,phase:'active',output_restore_generation:4,output_identity:'current',input:{ready:true},input_checkpoint:8,output:{result:{now:100},frame:{sgvs:[{mills:x.date,mgdl:x.value}]}}}));
  rows[1].work_due_at=300;const before=structuredClone(rows);before[0].work_due_at=90;
  return {expected,rows,before};
}
for(const [name,breakIt]of Object.entries({
  'missing tenant':x=>x.rows.pop(),
  'duplicate tenant':x=>x.rows[1]=structuredClone(x.rows[0]),
  'lost neighbor future due':x=>x.rows[1].work_due_at=null,
  'foreign tenant':x=>x.rows[0].tenant='foreign',
  'uncompleted observed work':x=>x.rows[0].work_observed[0]=9,
  'pending work':x=>x.rows[0].work_pending_at=1,
  'physical source ahead':x=>x.rows[0].last_stamp=9,
  'restore generation changed':x=>x.rows[0].restore=5,
  'stale accepted input':x=>x.rows[0].input_checkpoint=7,
  'input not ready':x=>x.rows[0].input.ready=false,
  'stale clinical output':x=>x.rows[1].output.frame.sgvs[0].mgdl=120,
  'old authority':x=>x.rows[0].output_identity='old',
  'due not executed':x=>x.rows[0].work_completed_at=89,
  'due not retired':x=>x.rows[0].work_due_at=90
}))test('recovery oracle red/restored: '+name,()=>{
 const x=recovered();assert.equal(qualify(x.rows,x.before,x.expected),true);const broken=structuredClone(x);breakIt(broken);
 assert.throws(()=>qualify(broken.rows,broken.before,broken.expected));assert.equal(qualify(x.rows,x.before,x.expected),true);
});

 test('recovery retains later genuine due work without forcing timer classification',()=>{const x=recovered();x.rows[0].work_due_at=200;assert.equal(qualify(x.rows,x.before,x.expected),true);});

 test('unchanged clinical content retains its body timestamp while durable due completion progresses',()=>{const x=recovered();x.rows[0].output.result.now=10;x.rows[0].work_due_at=200;assert.equal(qualify(x.rows,x.before,x.expected),true);});
