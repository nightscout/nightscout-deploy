#!/usr/bin/env node
'use strict';

// Fixture reuse by cold volume snapshot (seed once, restore per run).
//
//   node fixture.js snapshot <new dir>
//   node fixture.js restore <snapshot dir> --project <name> --state <new state dir>
//        [--bind 127.0.0.1] [--port 18080] [--backend-subnet <cidr> --edge-subnet <cidr>]
//
// `snapshot` copies the PostgreSQL data volume, the Vault storage volume and the private state
// directory (bootstrap custody, seeded credentials, TLS, primer results) of this checkout's
// prepared project, with every container stopped (`demo.sh snapshot` stops them first). The
// physical copy keeps the database system identifier, each tenant's checkpoints and the
// matching Vault keys. The only record beyond the copied files is
// snapshot.json: the image id and the core and deploy commits the snapshot came from.
//
// `restore` writes those copies into a fresh project's volumes and a fresh state directory and
// prepares this checkout's .env for it at this checkout's commits. The next `demo.sh up` unseals
// Vault, runs migrate up (bootstrap.js) and starts the roles behind their readiness checks.
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const base = __dirname;
const VOLUMES = ['postgres-data', 'vault-data'];
const fail = code => { throw Object.assign(new Error(code), { code }); };
const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();

function parseEnv (text) {
  const env = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(env, match[1])) fail('FIXTURE_ENV_INVALID');
    env[match[1]] = match[2];
  }
  return env;
}
const formatEnv = env => Object.entries(env).map(([key, value]) => key + '=' + value + '\n').join('');
function newDirectory (dir) {
  if (!path.isAbsolute(dir || '') || !/^\/[A-Za-z0-9_./-]+$/.test(dir) || dir.split('/').includes('..')) fail('FIXTURE_PATH_ABSOLUTE_REQUIRED');
  if (fs.realpathSync(path.dirname(dir)) !== path.dirname(dir)) fail('FIXTURE_PATH_ABSOLUTE_REQUIRED');
  if (fs.existsSync(dir)) fail('FIXTURE_PATH_EXISTS');
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}
const image = env => process.env.NS_DEMO_IMAGE || env.NS_DEMO_IMAGE || 'nightscout-multitenant-demo:local';
// One root helper container per copy: PostgreSQL and Vault data belong to their service users.
// The archive is handed back to the invoking user; extraction keeps the recorded owners.
function tar (helper, mounts, command) {
  const owner = process.getuid() + ':' + process.getgid();
  docker(['run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'sh', ...mounts.flatMap(m => ['-v', m]), helper, '-c', 'umask 077; ' + command.replaceAll('@OWNER@', owner)]);
}

function snapshot (dir, env = parseEnv(fs.readFileSync(path.join(base, '.env'), 'utf8'))) {
  const project = require('./project').validate(env.NS_DEMO_PROJECT), state = env.NS_DEMO_STATE;
  if (!path.isAbsolute(state || '') || !fs.statSync(state).isDirectory()) fail('FIXTURE_STATE_MISSING');
  // A cold copy: no container of this project may be running.
  if (docker(['ps', '-q', '--filter', 'label=com.docker.compose.project=' + project, '--filter', 'status=running'])) fail('FIXTURE_STOP_ROLES_FIRST');
  for (const volume of VOLUMES) docker(['volume', 'inspect', project + '_' + volume]);
  const helper = image(env), started = Date.now();
  newDirectory(dir);
  for (const volume of VOLUMES) tar(helper, [project + '_' + volume + ':/v:ro', dir + ':/out'], 'tar -C /v -cf /out/' + volume + '.tar . && chown @OWNER@ /out/' + volume + '.tar');
  tar(helper, [state + ':/v:ro', dir + ':/out'], 'tar -C /v -cf /out/state.tar . && chown @OWNER@ /out/state.tar');
  fs.writeFileSync(path.join(dir, 'deployment.env'), formatEnv(env), { mode: 0o600, flag: 'wx' });
  const record = { version: 1, sourceCommit: env.NS_SOURCE_COMMIT, deployCommit: env.NS_DEPLOY_COMMIT,
    image: docker(['image', 'inspect', '--format', '{{.Id}}', helper]) };
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
  return { ...record, seconds: (Date.now() - started) / 1000 };
}

function options (args) {
  const selected = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--project', '--state', '--bind', '--port', '--backend-subnet', '--edge-subnet'].includes(args[i]) || !args[i + 1]) fail('FIXTURE_USAGE');
    selected[args[i].slice(2)] = args[i + 1];
  }
  if (!selected.project || !selected.state) fail('FIXTURE_USAGE');
  return selected;
}
// The prepared settings of the snapshot, retargeted to the new project, state and this checkout.
function retarget (env, selected, commits) {
  const next = { ...env, NS_DEMO_PROJECT: require('./project').validate(selected.project), NS_DEMO_STATE: selected.state,
    NS_SOURCE_COMMIT: commits.source, NS_DEPLOY_COMMIT: commits.deploy };
  if (process.env.NS_DEMO_IMAGE) next.NS_DEMO_IMAGE = process.env.NS_DEMO_IMAGE;
  if (selected.bind) next.NS_DEMO_BIND = selected.bind;
  if (selected.port) next.NS_DEMO_PORT = selected.port;
  return next;
}

function restore (dir, args) {
  const selected = options(args), started = Date.now();
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
  if (record.version !== 1) fail('FIXTURE_SNAPSHOT_INVALID');
  const env = parseEnv(fs.readFileSync(path.join(dir, 'deployment.env'), 'utf8'));
  if (fs.existsSync(path.join(base, '.env'))) fail('FIXTURE_TARGET_ALREADY_PREPARED');
  const root = path.resolve(base, '../..'), build = require('./build');
  const source = build.assertCleanSource(root), deploy = build.overlay(root)?.deployCommit || source;
  const next = retarget(env, selected, { source, deploy }), project = next.NS_DEMO_PROJECT;
  if (docker(['ps','-aq','--filter','label=com.docker.compose.project='+project]) ||
      docker(['volume','ls','-q','--filter','label=com.docker.compose.project='+project])) fail('FIXTURE_PROJECT_NOT_FRESH');
  for (const volume of VOLUMES) {
    let exists = true;
    try { docker(['volume', 'inspect', project + '_' + volume]); } catch { exists = false; }
    if (exists) fail('FIXTURE_PROJECT_NOT_FRESH');
  }
  const helper = image(next), state = newDirectory(selected.state);
  const attempt = require('node:crypto').randomUUID(), created = [];
  try {
    for (const volume of VOLUMES) {
      const name = project + '_' + volume;
      docker(['volume', 'create', '--label', 'com.docker.compose.project=' + project, '--label', 'com.docker.compose.volume=' + volume,
        '--label', 'org.nightscout.fixture.restore=' + attempt, name]);
      if (docker(['volume', 'inspect', '--format', '{{index .Labels "org.nightscout.fixture.restore"}}', name]) !== attempt) fail('FIXTURE_PROJECT_NOT_FRESH');
      created.push(name);
      tar(helper, [name + ':/v', dir + ':/in:ro'], 'tar -C /v -xpf /in/' + volume + '.tar');
    }
    tar(helper, [state + ':/v', dir + ':/in:ro'], 'tar -C /v -xpf /in/state.tar && chown @OWNER@ /v && chmod 700 /v');
    const replicas = require('./replicas'), networks = require('./networks');
    fs.writeFileSync(path.join(state, 'compose.replicas.yaml'), replicas.compose(replicas.count(next), 'compose.yaml') +
      networks.render(networks.select(selected['backend-subnet'], selected['edge-subnet'])), { mode: 0o600 });
    fs.writeFileSync(path.join(base, '.env'), formatEnv(next), { mode: 0o600, flag: 'wx' });
  } catch (cause) {
    const errors = [cause];
    for (const name of created.reverse()) {
      try { docker(['volume', 'rm', name]); } catch (error) { errors.push(error); }
    }
    try { fs.rmSync(state, { recursive: true }); } catch (error) { errors.push(error); }
    if (errors.length > 1) throw new AggregateError(errors, 'FIXTURE_PARTIAL_RESTORE');
    throw cause;
  }
  return { project, state, snapshot: record, sourceCommit: source, deployCommit: deploy, seconds: (Date.now() - started) / 1000 };
}

if (require.main === module) {
  try {
    const [command, dir, ...rest] = process.argv.slice(2);
    let result;
    if (command === 'snapshot' && dir && !rest.length) result = snapshot(dir);
    else if (command === 'restore' && dir) result = restore(dir, rest);
    else fail('FIXTURE_USAGE');
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'FIXTURE_FAILED', detail: String(error?.stderr || error?.message || '').slice(0, 400) }) + '\n');
    process.exitCode = 1;
  }
}
module.exports = { parseEnv, formatEnv, retarget, options, snapshot, restore };
