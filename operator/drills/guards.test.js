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
