'use strict';
// Operator-owned finite native proof, never a default/pilot activation command.
const path = require('node:path'), fs = require('node:fs'), { spawnSync } = require('node:child_process');
const launch = require('../launch'), [tree, action] = process.argv.slice(2), p = launch.plan(tree), env = { ...process.env, ...p.runtime };
launch.custody(p, 'native-probe', env);
const compose = ['compose', '--project-name', p.project, '--project-directory', p.base, '--env-file', p.envFile, ...p.files.flatMap(f => ['-f', f]), '-f', '-'];
function run (args, options = {}) {
  const result = spawnSync('docker', args, { input: p.stdin, env, stdio: ['pipe', 'inherit', 'inherit'], timeout: 190000, ...options });
  if (result.error || result.status !== 0) process.exit(result.error ? 124 : result.status || 1);
  return result;
}
if (['stop-agent', 'start-agent', 'stop-vault', 'start-vault'].includes(action)) {
  const [verb, service] = action.split('-'); run([...compose, verb, service === 'agent' ? 'vault-agent' : service]);
} else if (action === 'secret-id') {
  for (const step of launch.commands(p, 'secret-id')) run(step.args);
} else if (action === 'inventory') {
  const listed = run(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + p.project], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
  const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
  const inspected = run(['inspect', ...ids], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], maxBuffer: 4194304 });
  const containers = JSON.parse(inspected.stdout).map(row => ({ service: row.Config.Labels['com.docker.compose.service'], containerId: row.Id, imageId: row.Image, imageReference: row.Config.Image,
    startedAt: row.State.StartedAt, status: row.State.Status, healthy: row.State.Health?.Status || null,
    sourceCommit: row.Config.Labels['org.opencontainers.image.revision'] || null, deployCommit: row.Config.Labels['org.nightscout.deploy.revision'] || null,
    mounts: row.Mounts.map(mount => ({ destination: mount.Destination, readOnly: !mount.RW })) }));
  const config = run([...compose, 'config', '--format', 'json'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], maxBuffer: 4194304 });
  const services = JSON.parse(config.stdout).services;
  const sink = Object.entries(services).filter(([, value]) => value.volumes?.some(v => v.target === '/run/ns-vault')).map(([name, value]) => ({ service: name, readOnly: value.volumes.find(v => v.target === '/run/ns-vault').read_only === true }));
  if (!['api', 'api-2'].every(name => sink.some(row => row.service === name && row.readOnly)) || sink.some(row => !['api', 'api-2', 'vault-agent'].includes(row.service))) throw new Error('NATIVE_SINK_CUSTODY');
  console.log(JSON.stringify({ project: p.project, sourceCommit: p.sourceCommit, deployCommit: p.deployCommit, apiInstances: p.apis, sinkMounts: sink, containers }));
} else {
  const proof = path.join(__dirname, 'native-probe.cjs');
  if (!fs.existsSync(proof)) throw new Error('NATIVE_PROBE_REQUIRED');
  run([...compose, '--profile', 'ops', 'run', '--rm', '--no-deps', '--volume', proof + ':/run/native-probe.cjs:ro', 'vault-agent-bootstrap', 'node', '/run/native-probe.cjs', action]);
}
