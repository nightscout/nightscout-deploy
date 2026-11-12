'use strict';
const path = require('node:path'), fs = require('node:fs'), { spawnSync } = require('node:child_process');
const launch = require('../launch'), [tree, operation] = process.argv.slice(2), p = launch.plan(tree), env = { ...process.env, ...p.runtime };
launch.custody(p, 'native-probe', env);
const name = 'ns-vault-agent-lifetime-control-20261112', owner = 'agent-lifetime-owned-20261112';
const image = 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2';
function run (args, options = {}) { const result = spawnSync('docker', args, { input: p.stdin, env, stdio: ['pipe', 'inherit', 'inherit'], timeout: 60000, ...options }); if (result.error || result.status !== 0) process.exit(result.error ? 124 : result.status || 1); return result; }
if (operation === 'start') {
  run(['run', '-d', '--name', name, '--label', 'nightscout.native.owner=' + owner, '--label', 'nightscout.native.role=secret-lifetime-control', '--network', p.project + '_backend',
    '--user', '1000:1000', '--read-only', '--tmpfs', '/tmp:mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--mount', 'type=bind,src=' + path.join(p.state, 'vault-agent-lifetime-control-20261112/creds') + ',dst=/run/ns-vault-creds',
    '--mount', 'type=bind,src=' + path.join(p.state, 'vault-agent-lifetime-control-20261112/sink') + ',dst=/run/ns-vault',
    '--mount', 'type=bind,src=' + path.resolve(__dirname, '../agent.hcl') + ',dst=/vault/config/agent.hcl,readonly',
    '--mount', 'type=bind,src=' + path.join(p.state, 'tls/ca.crt') + ',dst=/run/ns-ca/ca.crt,readonly',
    '--entrypoint', 'vault', image, 'agent', '-config=/vault/config/agent.hcl']);
} else if (operation === 'stop') {
  const inspected = run(['inspect', name], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }); const row = JSON.parse(inspected.stdout)[0];
  if (row.Config.Labels['nightscout.native.owner'] !== owner || row.Config.Image !== image) throw new Error('LIFETIME_RESOURCE_NOT_OWNED');
  run(['stop', row.Id]); run(['rm', row.Id]);
} else {
  const compose = ['compose', '--project-name', p.project, '--project-directory', p.base, '--env-file', p.envFile, ...p.files.flatMap(f => ['-f', f]), '-f', '-'];
  const probe = path.join(__dirname, 'secret-lifetime-probe.cjs'); if (!fs.existsSync(probe)) throw new Error('LIFETIME_PROBE_REQUIRED');
  run([...compose, '--profile', 'ops', 'run', '--rm', '--no-deps', '--volume', probe + ':/run/secret-lifetime-probe.cjs:ro', 'vault-agent-bootstrap', 'node', '/run/secret-lifetime-probe.cjs', operation]);
}
