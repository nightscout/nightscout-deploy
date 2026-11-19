#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const fail = code => Object.assign(new Error(code), { code });
const hash = /^[a-f0-9]{40}$/;
function read (file, maximum = 262144, privateFile = false) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum || privateFile && (before.mode & 0o077 || before.uid !== process.getuid())) throw fail('VAULT_AGENT_LAUNCH_FILE_REFUSED');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) throw fail('VAULT_AGENT_LAUNCH_FILE_REFUSED');
    const chunks = []; let total = 0;
    while (total <= maximum) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, maximum + 1 - total)), n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break; chunks.push(chunk.subarray(0, n)); total += n;
    }
    if (total > maximum) throw fail('VAULT_AGENT_LAUNCH_FILE_REFUSED');
    return Buffer.concat(chunks, total).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function environment (text) {
  const result = {};
  for (const line of text.split('\n')) {
    if (!line) continue; const match = /^([A-Z][A-Z0-9_]*)=([\x20-\x7e]*)$/.exec(line);
    if (!match || Object.hasOwn(result, match[1]) || !match[2] || /[`$\\]/.test(match[2])) throw fail('VAULT_AGENT_PREPARED_ENV_INVALID');
    result[match[1]] = match[2];
  }
  return result;
}
function execute (program, args, options = {}) {
  const result = spawnSync(program, args, { stdio: ['pipe', 'inherit', 'inherit'], timeout: 1200000, ...options });
  if (result.error || result.status !== 0) throw fail('VAULT_AGENT_LAUNCH_COMMAND_FAILED');
  return result;
}
function plan (tree, source = process.env) {
  const root = path.resolve(tree), base = path.join(root, 'deploy/multitenant'), here = __dirname;
  if (fs.realpathSync(root) !== root) throw fail('VAULT_AGENT_SOURCE_PATH_REFUSED');
  const envFile = path.join(base, '.env'), selected = environment(read(envFile, 262144, true));
  if (!hash.test(selected.NS_SOURCE_COMMIT || '') || !hash.test(selected.NS_DEPLOY_COMMIT || '') || !path.isAbsolute(selected.NS_DEMO_STATE || '')) throw fail('VAULT_AGENT_PREPARED_ENV_INVALID');
  const project = source.NS_VAULT_AGENT_PROJECT;
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project || '')) throw fail('VAULT_AGENT_PROJECT_REQUIRED');
  const marker = JSON.parse(read(path.join(base, '.overlay.json')));
  const hereRepository = path.resolve(here, '../../..');
  const overlay = spawnSync('git', ['-C', hereRepository, 'diff', '--quiet', selected.NS_DEPLOY_COMMIT, '--', 'bindings/compose/vault-agent']);
  if (overlay.status !== 0) throw fail('VAULT_AGENT_OVERLAY_SOURCE_CHANGED');
  const actual = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (actual.status !== 0 || actual.stdout.trim() !== selected.NS_SOURCE_COMMIT || marker.version !== 1 || marker.deployCommit !== selected.NS_DEPLOY_COMMIT) throw fail('VAULT_AGENT_SOURCE_CHANGED');
  const state = selected.NS_DEMO_STATE;
  if (fs.realpathSync(state) !== state || !fs.lstatSync(state).isDirectory() || fs.statSync(state).mode & 0o077 || fs.statSync(state).uid !== process.getuid()) throw fail('VAULT_AGENT_STATE_CUSTODY_REFUSED');
  const replicas = require(path.join(base, 'replicas')), count = replicas.count(selected), apis = replicas.instances(count).map(row => row.service);
  const rt = require(path.join(base, 'realtime-workers')), realtime = rt.selection(selected), rtServices = rt.services(realtime);
  let evServices = ['evaluator'];
  if (selected.NS_EVALUATOR_WORKERS !== undefined) {
    if (!fs.existsSync(path.join(base, 'evaluator-workers.js'))) throw fail('VAULT_AGENT_EVALUATOR_BINDING_REQUIRED');
    const ev = require(path.join(base, 'evaluator-workers')); evServices = ev.services(ev.selection(selected));
  }
  const files = [path.join(base, 'compose.yaml')];
  const add = (file, expected) => { const name = path.join(state, file), bytes = read(name, 262144, true); if (expected !== undefined && bytes !== expected) throw fail('VAULT_AGENT_ROSTER_CHANGED'); files.push(name); };
  add('compose.replicas.yaml', replicas.compose(count, path.join(base, 'compose.yaml')));
  if (realtime) add('compose.realtime.yaml', rt.compose(realtime, path.join(base, 'compose.yaml'), apis));
  if (selected.NS_EVALUATOR_WORKERS !== undefined) {
    const ev = require(path.join(base, 'evaluator-workers')); add('compose.evaluator.yaml', ev.compose(ev.selection(selected), path.join(base, 'compose.yaml')));
  }
  files.push(path.join(here, 'compose.vault-agent.yaml'));
  const allowed = ['NS_VAULT_AGENT_TOKEN_TTL', 'NS_VAULT_AGENT_TOKEN_MAX_TTL', 'NS_VAULT_AGENT_KEEP_ENV_TOKENS'];
  const runtime = { ...selected, NS_VAULT_AGENT_DIR: here, NS_VAULT_AGENT_PROJECT: project };
  for (const key of allowed) if (source[key] !== undefined) runtime[key] = source[key];
  const options = require('./vault-agent-bootstrap').input({ ...runtime, NS_VAULT_AGENT_BOOTSTRAP: '1', NS_BOOTSTRAP_OUTPUT: '/state', VAULT_ADDR: 'https://vault:8200' });
  const stdin = ['# Generated API-only Agent sink custody.', 'services:', ...apis.flatMap(name => [
    '  ' + name + ':', '    depends_on:', '      vault-agent: {condition: service_healthy}', '    volumes:',
    '      - ${NS_DEMO_STATE}/vault-agent/sink:/run/ns-vault:ro'])].join('\n') + '\n';
  return { root, base, state, project, envFile, files, stdin, runtime, apis, realtime: rtServices, evaluators: evServices,
    sourceCommit: selected.NS_SOURCE_COMMIT, deployCommit: selected.NS_DEPLOY_COMMIT, ttl: options.ttl, maxTtl: options.maxTtl };
}
function commands (selected, command, detail) {
  const compose = (...args) => ({ program: 'docker', args: ['compose', '--project-name', selected.project, '--project-directory', selected.base, '--env-file', selected.envFile,
    ...selected.files.flatMap(file => ['-f', file]), '-f', '-', ...args], input: selected.stdin });
  const node = (...args) => ({ program: process.execPath, args });
  const up = (...services) => compose('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '900', ...services);
  const run = (service, ...args) => compose('--profile', 'ops', 'run', '--rm', '--no-deps', service, ...args);
  if (command === 'config') return [compose('config', '--quiet')];
  if (command === 'build') return [node(path.join(selected.base, 'build.js'))];
  if (['up', 'bootstrap'].includes(command)) {
    const steps = [node(path.join(selected.base, 'build.js'), '--check-image'), up('postgres', 'vault'), run('bootstrap')];
    if (command === 'bootstrap') return [...steps, run('vault-agent-bootstrap')];
    return [...steps, up('admin', 'feed-reader'), run('primer', 'node', 'deploy/multitenant/platform-verify.js'),
      run('vault-agent-bootstrap'), up('vault-agent'),
      up(...selected.apis, ...selected.realtime, ...selected.evaluators, 'pgstream', 'tenant-admin', 'ui', 'nginx')];
  }
  if (command === 'prime' || command === 'demo') {
    return [
      run('primer', 'node', 'deploy/multitenant/prime.js', 'provision'),
      compose('--profile', 'ops', 'run', '--rm', '--no-deps', '-e', 'NS_DEMO_TENANTS=' + (process.env.NS_DEMO_TENANTS || '2'),
        'bootstrap', 'node', 'deploy/multitenant/commission-restore.js'),
      run('primer', 'node', 'deploy/multitenant/prime.js', 'prime'), node(path.join(selected.base, 'publish-primer.js'), selected.state),
      ...(command === 'demo' ? [run('demo')] : [])];
  }
  if (command === 'secret-id') return [run('vault-agent-bootstrap', 'node', '/run/ns-overlay/vault-agent-bootstrap.js', 'secret-id')];
  if (command === 'agent' && ['stop', 'start', 'logs'].includes(detail)) return [compose(detail, 'vault-agent')];
  if (command === 'status') return [compose('ps', '-a')];
  if (['stop', 'down', 'destroy'].includes(command)) return [compose(command === 'destroy' ? 'down' : command, ...(command === 'destroy' ? ['-v'] : []))];
  throw fail('VAULT_AGENT_LAUNCH_USAGE');
}
function custody (selected, command, env) {
  const record = { version: 1, sourceCommit: selected.sourceCommit, deployCommit: selected.deployCommit, project: selected.project,
    state: selected.state, base: selected.base, apis: selected.apis, realtime: selected.realtime, evaluators: selected.evaluators,
    ttl: selected.ttl, maxTtl: selected.maxTtl, overlayDigest: require('./vault-agent-bootstrap').digest(selected.stdin) };
  const helper = require('./vault-agent-bootstrap'), receipt = path.join(selected.state, 'vault-agent.launch.json');
  const exists = fs.existsSync(receipt);
  if (exists && helper.digest(JSON.parse(helper.privateBytes(receipt))) !== helper.digest(record)) throw fail('VAULT_AGENT_PROJECT_STATE_CHANGED');
  if (['plan', 'config', 'status', 'build'].includes(command)) return;
  const inspected = spawnSync('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + selected.project], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, env });
  if (inspected.error || inspected.status !== 0) throw fail('VAULT_AGENT_PROJECT_INSPECTION_FAILED');
  const ids = inspected.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length > 128 || ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw fail('VAULT_AGENT_PROJECT_INSPECTION_FAILED');
  if (!exists && (ids.length || ['stop', 'down', 'destroy', 'agent', 'secret-id', 'prime', 'demo'].includes(command))) throw fail('VAULT_AGENT_PROJECT_NOT_OWNED');
  if (ids.length) {
    const inventory = spawnSync('docker', ['inspect', ...ids], { encoding: 'utf8', timeout: 10000, maxBuffer: 4194304, env });
    if (inventory.error || inventory.status !== 0) throw fail('VAULT_AGENT_PROJECT_INSPECTION_FAILED');
    const containers = JSON.parse(inventory.stdout), applications = new Set([...selected.apis, ...selected.realtime.filter(x => x !== 'socket-edge'), ...selected.evaluators, 'bootstrap', 'vault-agent-bootstrap', 'primer', 'demo', 'admin', 'feed-reader', 'tenant-admin', 'ui', 'socket-edge', 'placement-operator']);
    const allowed = new Set([...applications, 'postgres', 'vault', 'vault-agent', 'nginx']);
    for (const row of containers) {
      const labels = row.Config.Labels || {}, service = labels['com.docker.compose.service'];
      if (labels['com.docker.compose.project'] !== selected.project || labels['com.docker.compose.project.working_dir'] !== selected.base || !allowed.has(service) ||
          applications.has(service) && (labels['org.opencontainers.image.revision'] !== selected.sourceCommit || labels['org.nightscout.deploy.revision'] !== selected.deployCommit)) throw fail('VAULT_AGENT_PROJECT_IDENTITY_CHANGED');
      if (!row.Mounts.some(mount => mount.Type === 'bind' && (mount.Source === selected.state || mount.Source.startsWith(selected.state + '/')))) throw fail('VAULT_AGENT_PROJECT_IDENTITY_CHANGED');
    }
  }
  if (!exists) helper.replacePrivate(receipt, JSON.stringify(record) + '\n', { exclusive: true });
}
function main (args, source = process.env) {
  const [tree, command, detail] = args;
  if (!tree || !command || args.length > 3) throw fail('VAULT_AGENT_LAUNCH_USAGE');
  const selected = plan(tree, source);
  if (command === 'plan') {
    console.log(JSON.stringify({ version: 1, sourceCommit: selected.sourceCommit, deployCommit: selected.deployCommit, project: selected.project,
      state: selected.state, apiInstances: selected.apis, realtimeServices: selected.realtime, evaluatorServices: selected.evaluators,
      tokenTtl: selected.ttl, tokenMaxTtl: selected.maxTtl, composeFiles: selected.files })); return;
  }
  // Only explicitly selected overlay settings cross into Compose. Prepared .env
  // remains authoritative for roster/source/state; shell overrides cannot retarget.
  const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK'].filter(k => source[k] !== undefined).map(k => [k, source[k]]));
  Object.assign(env, selected.runtime);
  const steps = commands(selected, command, detail);
  custody(selected, command, env);
  for (const step of steps) execute(step.program, step.args, { cwd: selected.base, env, input: step.input });
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { console.error(JSON.stringify({ error: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'VAULT_AGENT_LAUNCH_REFUSED' })); process.exitCode = 1; } }
module.exports = { plan, commands, environment, custody, main };
