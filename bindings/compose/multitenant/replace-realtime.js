#!/usr/bin/env node
'use strict';
// Host-side fixed-roster operator. Docker authority stays on the host; the
// private publisher container gets only its existing operator/reader custody.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const fail = code => Object.assign(new Error(code), { code });
function argumentsFor(args) {
  const options = { compose: [], timeout: '60000' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2), value = args[i + 1];
    if (!['project','state','compose','worker','timeout','shard','to'].includes(key) || !value) throw fail('PLACEMENT_REPLACEMENT_USAGE');
    if (key === 'compose') options.compose.push(path.resolve(value)); else if (Object.hasOwn(options, key) && key !== 'timeout') throw fail('PLACEMENT_REPLACEMENT_USAGE'); else options[key] = value;
  }
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(options.project || '') || !/^realtime-[1-9][0-9]?$/.test(options.worker || '') || !/^\/[A-Za-z0-9_./-]+$/.test(options.state || '') || !options.compose.length ||
      !/^[1-9][0-9]{0,5}$/.test(options.timeout) || Number(options.timeout) > 900000) throw fail('PLACEMENT_REPLACEMENT_USAGE');
  options.timeout = Number(options.timeout);
  if ((options.shard === undefined) !== (options.to === undefined) || options.shard !== undefined &&
      (!/^(0|[1-9][0-9]{0,4})$/.test(options.shard) || !/^realtime-[1-9][0-9]?$/.test(options.to))) throw fail('PLACEMENT_REPLACEMENT_USAGE');
  return options;
}
function privateJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 1048576) throw fail('PLACEMENT_PRIVATE_FILE_REQUIRED');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function replacement(before, worker, { shard, to } = {}) {
  const old = before.workers.find(row => row.id === worker);
  if (!old) throw fail('PLACEMENT_FIXED_WORKER_REQUIRED');
  const owners = [...before.owners];
  if (shard !== undefined) {
    if (!Number.isSafeInteger(Number(shard)) || before.owners[Number(shard)] !== worker || !before.workers.some(row => row.id === to) || to === worker) throw fail('PLACEMENT_FIXED_WORKER_REQUIRED');
    owners[Number(shard)] = to;
  }
  return { ...before, owners, generation: before.generation + 1,
    workers: before.workers.map(row => row.id === worker ? { ...row, incarnation: crypto.randomUUID() } : row),
    transition: { previousGeneration: before.generation, previousOwners: before.owners.map(id => {
      const row = before.workers.find(entry => entry.id === id); return row ? { worker: row.id, incarnation: row.incarnation } : null;
    }), stopped: [{ worker, incarnation: old.incarnation }] } };
}
function atomicJson(file, value) {
  privateJson(file);
  const temporary = path.join(path.dirname(file), '.boot-' + crypto.randomBytes(12).toString('hex'));
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
async function replace(options) {
  const state = fs.realpathSync(options.state);
  if (state !== path.resolve(options.state)) throw fail('PLACEMENT_PRIVATE_FILE_REQUIRED');
  const complete = privateJson(path.join(state, 'bootstrap/complete.json'));
  const before = privateJson(path.join(state, 'placement/backend.json'));
  const candidate = replacement(before, options.worker, options);
  const index = before.workers.findIndex(row => row.id === options.worker), service = require('./realtime-workers').serviceOf(index);
  const envFile = path.join(state, service, 'env.json'), env = privateJson(envFile);
  if (env.REALTIME_WORKER_ID !== options.worker || env.REALTIME_WORKER_INCARNATION !== before.workers[index].incarnation) throw fail('PLACEMENT_BOOT_IDENTITY_CHANGED');
  const compose = ['compose','-p',options.project,'--profile','ops','--env-file',path.join(path.dirname(options.compose[0]), '.env'), ...options.compose.flatMap(file => ['-f', file])];
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 30000, maxBuffer: 4 * 1024 * 1024 }).trim();
  const id = docker([...compose, 'ps','--all','--quiet',service]);
  if (!/^[a-f0-9]{64}$/.test(id)) throw fail('PLACEMENT_FIXED_CONTAINER_REQUIRED');
  const original = JSON.parse(docker(['inspect',id]))[0];
  if (original.Config.Labels?.['com.docker.compose.project'] !== options.project || original.Config.Labels?.['com.docker.compose.service'] !== service || original.HostConfig.RestartPolicy.Name !== 'no') throw fail('PLACEMENT_PLATFORM_IDENTITY_CHANGED');
  const labels = JSON.parse(docker(['image','inspect',original.Image]))[0].Config.Labels;
  if (labels?.['org.opencontainers.image.revision'] !== complete.sourceCommit || labels?.['org.nightscout.deploy.revision'] !== complete.deployCommit) throw fail('PLACEMENT_SOURCE_IDENTITY_CHANGED');
  const configuration = JSON.parse(docker([...compose,'config','--format','json']));
  for (const selected of ['demo',service]) {
    const image = configuration.services?.[selected]?.image;
    if (!image || JSON.parse(docker(['image','inspect',image]))[0].Id !== original.Image) throw fail('PLACEMENT_SOURCE_IDENTITY_CHANGED');
  }
  const exactOld = owner => owner?.worker === options.worker && owner.incarnation === before.workers[index].incarnation;
  function stopped() {
    const row = JSON.parse(docker(['inspect',id]))[0];
    if (row.Id !== original.Id || row.State.StartedAt !== original.State.StartedAt || row.Config.Labels?.['com.docker.compose.project'] !== options.project || row.Config.Labels?.['com.docker.compose.service'] !== service) throw fail('PLACEMENT_PLATFORM_IDENTITY_CHANGED');
    return row.State.Running === false && row.State.Pid === 0;
  }
  const name = options.project + '-placement-' + crypto.randomBytes(6).toString('hex');
  const child = spawn('docker', [...compose,'run','--rm','-T','--no-deps','--name',name,
    '-v',path.join(state,'placement') + ':/run/ns-placement:rw', '-v',path.join(state,'realtime') + ':/run/ns-warm-config:ro',
    'demo','node','-r','./deploy/multitenant/load-env.js','deploy/multitenant/placement-control.js'], { stdio: ['pipe','pipe','pipe'] });
  let result, refused = false, errors = '', processing = Promise.resolve();
  const timer = setTimeout(() => {
    refused = true;
    // This exact one-shot container belongs to this invocation. Stopping it
    // releases any publication fence; the new assignment is never rolled back.
    try { docker(['stop','--time','5',name]); } catch { /* Report uncertainty below. */ }
    child.kill('SIGTERM');
  }, options.timeout + 30000); timer.unref();
  const lines = require('node:readline').createInterface({ input: child.stdout });
  child.stderr.on('data', bytes => { if (errors.length < 4096) errors += bytes.toString().slice(0,4096 - errors.length); });
  child.stdin.on('error', () => { refused = true; });
  lines.on('line', line => {
    processing = processing.then(async () => {
      if (line.length > 4096) throw fail('PLACEMENT_PLATFORM_PROTOCOL_REFUSED');
      const event = JSON.parse(line);
      if (event.kind === 'placement-complete') { result = event; return; }
      if (event.kind !== 'placement-action' || !Number.isSafeInteger(event.id)) throw fail('PLACEMENT_PLATFORM_PROTOCOL_REFUSED');
      let ok = false;
      if (event.name === 'confirm' && exactOld(event.owner)) ok = stopped();
      else if (event.name === 'stop' && exactOld(event.owner)) { docker(['stop','--time','10',id]); ok = stopped(); }
      else if (event.name === 'activate' && Object.keys(event.owner || {}).length === 0) {
        if (!stopped()) throw fail('REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED');
        // Read the file actually published under the product's exclusive fence.
        const actual = privateJson(path.join(state,'placement/backend.json'));
        if (JSON.stringify(actual) !== JSON.stringify(candidate)) throw fail('PLACEMENT_ASSIGNMENT_CHANGED');
        atomicJson(envFile, { ...env, REALTIME_WORKER_INCARNATION: candidate.workers[index].incarnation });
        docker([...compose,'up','-d','--no-deps','--force-recreate',service]); ok = true;
      }
      child.stdin.write(JSON.stringify({ id: event.id, ok }) + '\n');
    }).catch(() => { refused = true; child.stdin.end(); });
  });
  child.stdin.write(JSON.stringify({ candidate, timeoutMs: options.timeout }) + '\n');
  try {
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    await processing;
    if (code !== 0 || refused || !result) throw fail('PLACEMENT_REPLACEMENT_FAILED_OR_UNCERTAIN');
    return result;
  } finally { clearTimeout(timer); lines.close(); child.stdin.end(); }
}
if (require.main === module) Promise.resolve().then(() => replace(argumentsFor(process.argv.slice(2)))).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write((/^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'PLACEMENT_REPLACEMENT_FAILED_OR_UNCERTAIN') + '\n'); process.exitCode = 1; });
module.exports = { argumentsFor, replacement, privateJson, atomicJson, replace };
