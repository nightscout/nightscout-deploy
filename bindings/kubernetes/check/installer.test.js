'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
test('admin uses its mounted Secret and pod IP; standalone UI receives private regular files', t => {
  const root = path.resolve(__dirname, '..');
  const rendered = JSON.parse(execFileSync('tk', ['eval', 'environments/synthetic'], { cwd: root }));
  const {documents} = JSON.parse(execFileSync('tk', ['eval', 'environments/synthetic', '-e', 'inventory'], { cwd: root }));
  assert.deepEqual(Object.keys(documents).filter(role => documents[role].includes('ns_owner_settings_pg')), ['tenant-admin']);
  const owner = rendered.components['tenant-admin'].deployment.spec.template.spec;
  assert(owner.volumes.some(v => v.name === 'secret-tenant-admin' && v.secret.secretName === 'ns-config-tenant-admin'));
  assert(owner.containers[0].volumeMounts.some(m => m.name === 'secret-tenant-admin' && m.mountPath === '/run/ns-config' && m.readOnly));
  const admin = rendered.admin.deployment.spec.template.spec;
  assert.equal(admin.initContainers.length, 0);
  const app = admin.containers[0];
  assert.equal(app.env.find(row => row.name === 'ADMIN_HOSTNAME').valueFrom.fieldRef.fieldPath, 'status.podIP');
  assert(app.volumeMounts.some(m => m.name === 'secret-admin' && m.mountPath === '/run/ns-config' && m.readOnly));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-install-ui-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(tmp + '/secret/ui/..data', { recursive: true });
  for (const name of ['config.json', 'env.json']) {
    fs.writeFileSync(tmp + '/secret/ui/..data/' + name, '{}');
    fs.symlinkSync('..data/' + name, tmp + '/secret/ui/' + name);
  }
  const install = rendered.ui.deployment.spec.template.spec.initContainers[0].command;
  execFileSync('node', ['-e', install[2].replaceAll('/run/ns-secret', tmp + '/secret').replaceAll('/run/ns-config', tmp + '/config')]);
  const file = fs.lstatSync(tmp + '/config/ui/d/env.json');
  assert(file.isFile() && !file.isSymbolicLink());
  assert.equal(file.mode & 0o777, 0o400);
});
