'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validate, privateJson, stopped, coldBackup, beginOperation } = require('./revision-transition');
const commit = 'a'.repeat(40), deploy = 'b'.repeat(40), id = 'c'.repeat(64), image = 'sha256:' + 'd'.repeat(64);
const plan = () => ({ version: 1, profile: 'ordinary-single', project: 'recovery-drills-revision-test', directory: '/tmp/private-result', coldBackup: '/tmp/private-backup', state: '/tmp/private-state',
  source: { root: '/tmp/source', sourceCommit: commit, deployCommit: deploy }, target: { root: '/tmp/target', sourceCommit: 'e'.repeat(40), deployCommit: deploy, image },
  database: { name: 'synthetic', oid: '123', systemIdentifier: '456' }, cohort: [{ id, image }], rollbackNamespaces: { entries: 'fresh_entries' } });
test('refuses ambiguous revision/profile/cohort plans', () => {
  validate(plan());
  for (const change of [{ profile: 'selected' }, { project: 'Invalid project' }, { directory: 'relative' }, { cohort: [] }, { source: plan().target }, { database: {} }]) {
    assert.throws(() => validate({ ...plan(), ...change }), { code: 'REVISION_PLAN_REFUSED' });
  }
});
test('stopped census binds the exact complete application cohort and images', () => {
  const row = { Id: id, Image: image, State: { Running: false, Restarting: false }, Config: { Labels: { 'com.docker.compose.service': 'api', 'com.docker.compose.project': plan().project } } };
  const check = rows => { const fixed = ['evaluator','realtime'].map((service,i) => ({ ...row, Id: String(i + 1).repeat(64), Config: { Labels: { ...row.Config.Labels, 'com.docker.compose.service': service } } })); const all = [...rows, ...fixed]; const p = { ...plan(), cohort: [row, ...fixed].map(r => ({ id: r.Id, image: r.Image })) }; return stopped(p, args => args[0] === 'ps' ? all.map(r => r.Id).join('\n') : JSON.stringify(all)); };
  check([row]);
  for (const rows of [[], [{ ...row, Image: 'sha256:' + 'f'.repeat(64) }], [{ ...row, State: { Running: true } }], [row, { ...row, Id: 'f'.repeat(64) }]]) {
    assert.throws(() => check(rows), error => ['REVISION_COHORT_CHANGED_OR_RUNNING','REVISION_SELECTED_PROFILE_UNSUPPORTED'].includes(error.code));
  }
});
test('ordinary default projects are admitted while another valid project cannot adopt their cohort', () => {
  const project = require('../bindings/compose/multitenant/project');
  for (const name of [project.DEFAULT, 'nsdemo']) {
    const p = validate({ ...plan(), project: name });
    const rows = ['api','evaluator','realtime'].map((service,i) => ({ Id: String(i + 1).repeat(64), Image: image,
      State: { Running: false, Restarting: false }, Config: { Labels: { 'com.docker.compose.service': service, 'com.docker.compose.project': name } } }));
    p.cohort = rows.map(row => ({ id: row.Id, image: row.Image }));
    const run = args => args[0] === 'ps' ? rows.map(r => r.Id).join('\n') : JSON.stringify(rows);
    stopped(p, run);
    const wrong = validate({ ...p, project: 'another-valid-project' });
    assert.throws(() => stopped(wrong, run), { code: 'REVISION_COHORT_CHANGED_OR_RUNNING' });
  }
});
test('requires complete paired cold custody and refuses a changed archive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-command-'));
  try {
    fs.chmodSync(dir, 0o700);
    const files = {};
    for (const name of ['deployment.env', 'postgres-data.tar', 'state.tar', 'vault-data.tar']) {
      fs.writeFileSync(path.join(dir, name), 'synthetic-' + name, { mode: 0o600 });
      files[name] = crypto.createHash('sha256').update('synthetic-' + name).digest('hex');
    }
    const manifest = { version: 1, kind: 'compose-cold-backup', project: plan().project, sourceCommit: commit, deployCommit: deploy, files };
    const file = path.join(dir, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify(manifest), { mode: 0o600 });
    const input = { ...plan(), coldBackup: dir };
    assert.match(coldBackup(input), /^[a-f0-9]{64}$/);
    fs.appendFileSync(path.join(dir, 'vault-data.tar'), 'changed');
    assert.throws(() => coldBackup(input), { code: 'REVISION_COLD_BACKUP_DIGEST' });
    fs.chmodSync(file, 0o644);
    assert.throws(() => privateJson(file), { code: 'REVISION_PRIVATE_FILE_REQUIRED' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('interruption never silently replays the same mutating operation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-interrupted-'));
  try {
    beginOperation(directory, 'upgrade', plan(), 'synthetic-custody');
    const before = fs.readFileSync(path.join(directory, 'upgrade-started.json'));
    assert.throws(() => beginOperation(directory, 'upgrade', plan(), 'changed'), { code: 'REVISION_INTERRUPTED_OR_ALREADY_RUN' });
    assert.deepEqual(fs.readFileSync(path.join(directory, 'upgrade-started.json')), before);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('cross-revision oracle requires current completed content and current physical stamps', () => {
  const { qualify } = require('./drills/container/revision-transition.cjs');
  const expected = [{ tenant: 'synthetic-a', date: 1000, value: 90 }, { tenant: 'synthetic-b', date: 1001, value: 120 }];
  const rows = expected.map(x => ({ tenant: x.tenant, work_observed: [1,2,3,4], work_completed: [1,2,3,4], work_pending_at: null,
    last_stamp: 1, settings: 2, policy: 3, activity: 4, input_checkpoint: 1, restore: 2, output_restore_generation: 2, phase: 'active', input: { ready: true }, output: { frame: { sgvs: [{ mills: x.date, mgdl: x.value }] } } }));
  qualify(rows, expected);
  for (const patch of [{ last_stamp: 9 }, { output_restore_generation: 1 }, { work_pending_at: 123 }, { output: { frame: { sgvs: [] } } }]) {
    assert.throws(() => qualify([{ ...rows[0], ...patch }, rows[1]], expected));
  }
});
