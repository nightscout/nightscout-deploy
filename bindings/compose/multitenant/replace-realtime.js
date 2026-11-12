#!/usr/bin/env node
'use strict';
// Host-side fixed-roster operator. Docker authority stays on the host; the
// private publisher container gets only its existing operator/reader custody.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const journal = require('./replacement-journal');
const fail = code => Object.assign(new Error(code), { code });
const { privateJson, atomicJson } = journal;
function argumentsFor(args) {
  const options = { compose: [], timeout: '60000' };
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--recover') { if (options.recover) throw fail('PLACEMENT_REPLACEMENT_USAGE'); options.recover = true; i--; continue; }
    const key = args[i]?.slice(2), value = args[i + 1];
    if (!['project','state','compose','worker','timeout','shard','to'].includes(key) || !value) throw fail('PLACEMENT_REPLACEMENT_USAGE');
    if (key === 'compose') options.compose.push(path.resolve(value)); else if (Object.hasOwn(options, key) && key !== 'timeout') throw fail('PLACEMENT_REPLACEMENT_USAGE'); else options[key] = value;
  }
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(options.project || '') || !/^realtime-[1-9][0-9]?$/.test(options.worker || '') || !/^\/[A-Za-z0-9_./-]+$/.test(options.state || '') || !options.compose.length ||
      !/^[1-9][0-9]{0,5}$/.test(options.timeout) || Number(options.timeout) > 900000) throw fail('PLACEMENT_REPLACEMENT_USAGE');
  options.timeout = Number(options.timeout);
  if (options.recover && (options.shard !== undefined || options.to !== undefined)) throw fail('PLACEMENT_REPLACEMENT_USAGE');
  if ((options.shard === undefined) !== (options.to === undefined) || options.shard !== undefined &&
      (!/^(0|[1-9][0-9]{0,4})$/.test(options.shard) || !/^realtime-[1-9][0-9]?$/.test(options.to))) throw fail('PLACEMENT_REPLACEMENT_USAGE');
  return options;
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
async function replace(options, hooks = {}) {
  return journal.locked(options.state, lockFd => replaceLocked(options, { ...hooks, lockFd }));
}
async function replaceLocked(options, hooks) {
  const state = fs.realpathSync(options.state);
  if (state !== path.resolve(options.state)) throw fail('PLACEMENT_PRIVATE_FILE_REQUIRED');
  const complete = privateJson(path.join(state, 'bootstrap/complete.json'));
  let before = privateJson(path.join(state, 'placement/backend.json'));
  let routes = privateJson(path.join(state, 'placement/routes.json'));
  const journalFile = path.join(state, 'placement/operation.json');
  const prior = fs.existsSync(journalFile) ? privateJson(journalFile) : null;
  if (prior && !/^[a-f0-9]{32}$/.test(prior.operation || '')) throw fail('PLACEMENT_RECOVERY_IDENTITY_CHANGED');
  if (prior && prior.phase !== 'complete' && !options.recover) throw fail('PLACEMENT_RECOVERY_REQUIRED');
  if (options.recover && (!prior || prior.phase === 'complete')) throw fail('PLACEMENT_RECOVERY_NOT_REQUIRED');
  const index = before.workers.findIndex(row => row.id === options.worker), service = require('./realtime-workers').serviceOf(index);
  const envFile = path.join(state, service, 'env.json');
  let env = privateJson(envFile);
  if (!options.recover && (env.REALTIME_WORKER_ID !== options.worker || env.REALTIME_WORKER_INCARNATION !== before.workers[index].incarnation)) throw fail('PLACEMENT_BOOT_IDENTITY_CHANGED');
  const compose = ['compose','-p',options.project,'--profile','ops','--env-file',path.join(path.dirname(options.compose[0]), '.env'), ...options.compose.flatMap(file => ['-f', file])];
  const docker = hooks.docker || (args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe',hooks.lockFd], timeout: 30000, maxBuffer: 4 * 1024 * 1024 }).trim());
  if (options.recover) {
    if (prior.project !== options.project || prior.state !== state || prior.worker !== options.worker || prior.source?.core !== complete.sourceCommit || prior.source?.deploy !== complete.deployCommit ||
        prior.publisherName !== options.project + '-placement-' + prior.operation) throw fail('PLACEMENT_RECOVERY_IDENTITY_CHANGED');
    const publisherId = docker(['ps','--all','--quiet','--no-trunc','--filter','name=^/' + prior.publisherName + '$']);
    if (publisherId) {
      if (!/^[a-f0-9]{64}$/.test(publisherId)) throw fail('PLACEMENT_RECOVERY_PROCESS_AMBIGUOUS');
      const actor = JSON.parse(docker(['inspect',publisherId]))[0];
      if (actor.Image !== prior.image || actor.Config.Labels?.['com.docker.compose.project'] !== options.project ||
          actor.Config.Labels?.['com.docker.compose.service'] !== 'demo' || actor.Config.Labels?.['org.nightscout.replacement.operation'] !== prior.operation) throw fail('PLACEMENT_RECOVERY_PROCESS_AMBIGUOUS');
      if (actor.State.Running) docker(['stop','--time','5',publisherId]);
      // --rm can remove the actor immediately after exit. An absent exact name
      // also proves it cannot continue publishing; a reused name/Id refuses.
      const after = docker(['ps','--all','--quiet','--no-trunc','--filter','name=^/' + prior.publisherName + '$']);
      if (after) {
        if (after !== publisherId) throw fail('PLACEMENT_PLATFORM_IDENTITY_CHANGED');
        const stopped = JSON.parse(docker(['inspect',publisherId]))[0];
        if (stopped.State.StartedAt !== actor.State.StartedAt || stopped.State.Running || stopped.State.Pid !== 0) throw fail('PLACEMENT_RECOVERY_PROCESS_AMBIGUOUS');
      }
    }
    before = privateJson(path.join(state, 'placement/backend.json')); routes = privateJson(path.join(state, 'placement/routes.json')); env = privateJson(envFile);
  }
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
  const composeIdentity = [...options.compose, path.join(path.dirname(options.compose[0]), '.env')].map(file => ({ path: file, sha256: journal.bytesDigest(file) }));
  let recovery;
  if (options.recover) recovery = journal.recoverable(prior, { project: options.project, state, worker: options.worker, complete, compose: composeIdentity, backend: before, routes, env, row: original });
  const move = options.recover ? recovery.published ? {} : prior.move : { ...(options.shard === undefined ? {} : { shard: options.shard, to: options.to }) };
  const candidate = replacement(before, options.worker, move);
  const operation = crypto.randomBytes(16).toString('hex');
  const nextEnv = { ...env, REALTIME_WORKER_INCARNATION: candidate.workers[index].incarnation };
  const record = { version: 1, operation, publisherName: options.project + '-placement-' + operation, phase: 'prepared', project: options.project, state, worker: options.worker,
    source: { core: complete.sourceCommit, deploy: complete.deployCommit }, image: original.Image, compose: composeIdentity, move,
    beforeDigest: journal.digest(before), candidateDigest: journal.digest(candidate), routesDigest: journal.digest(routes),
    oldEnvDigest: journal.digest(env), newEnvDigest: journal.digest(nextEnv), oldIncarnation: before.workers[index].incarnation,
    newIncarnation: candidate.workers[index].incarnation, oldIdentity: journal.identity(original),
    ...(recovery ? { recovery: { prior: prior.operation, digest: journal.digest(prior), ...recovery } } : {}) };
  if (prior) atomicJson(path.join(state, 'placement/history-' + prior.operation + '.json'), prior, true);
  const persist = phase => { record.phase = phase; atomicJson(journalFile, record, true); };
  const checkpoint = hooks.checkpoint || (async () => {});
  persist('prepared');
  const exactOld = owner => owner?.worker === options.worker && owner.incarnation === before.workers[index].incarnation;
  function stopped() {
    const row = JSON.parse(docker(['inspect',id]))[0];
    if (row.Id !== original.Id || row.State.StartedAt !== original.State.StartedAt || row.State.Running && row.State.Pid !== original.State.Pid || row.Config.Labels?.['com.docker.compose.project'] !== options.project || row.Config.Labels?.['com.docker.compose.service'] !== service) throw fail('PLACEMENT_PLATFORM_IDENTITY_CHANGED');
    return row.State.Running === false && row.State.Pid === 0;
  }
  const action = async event => {
    let ok = false;
    if (event.name === 'confirm' && exactOld(event.owner)) ok = stopped();
    else if (event.name === 'stop' && exactOld(event.owner)) { persist('stop-intent'); await checkpoint('before-stop'); docker(['stop','--time','10',id]); ok = stopped(); if (ok) persist('stopped'); await checkpoint('after-stop'); }
    else if (event.name === 'activate' && Object.keys(event.owner || {}).length === 0) {
      if (!stopped()) throw fail('REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED');
      // Read the file actually published under the product's exclusive fence.
      const actual = privateJson(path.join(state,'placement/backend.json'));
      if (JSON.stringify(actual) !== JSON.stringify(candidate)) throw fail('PLACEMENT_ASSIGNMENT_CHANGED');
      await checkpoint('after-assignment');
      persist('env-intent'); atomicJson(envFile, nextEnv); persist('env-written'); await checkpoint('after-env');
      const override = path.join(state, 'placement/activation-' + operation + '.json');
      atomicJson(override, { services: { [service]: { labels: { 'org.nightscout.replacement.operation': operation, 'org.nightscout.replacement.incarnation': record.newIncarnation } } } }, true);
      record.activation = { path: override, sha256: journal.bytesDigest(override) }; persist('create-intent');
      docker([...compose,'-f',override,'up','--no-start','--no-build','--pull','never','--no-deps','--force-recreate',service]); await checkpoint('after-create-effect');
      const createdId = docker([...compose,'ps','--all','--quiet',service]);
      if (!/^[a-f0-9]{64}$/.test(createdId)) throw fail('PLACEMENT_FIXED_CONTAINER_REQUIRED');
      const created = JSON.parse(docker(['inspect',createdId]))[0];
      if (created.State.Running || !/^0001-01-01T00:00:00(?:\.0+)?Z$/.test(created.State.StartedAt) || created.Image !== original.Image ||
          created.Config.Labels?.['com.docker.compose.project'] !== options.project || created.Config.Labels?.['com.docker.compose.service'] !== service ||
          created.Config.Labels?.['org.nightscout.replacement.operation'] !== operation || created.Config.Labels?.['org.nightscout.replacement.incarnation'] !== record.newIncarnation || created.HostConfig.RestartPolicy.Name !== 'no') throw fail('PLACEMENT_PLATFORM_IDENTITY_CHANGED');
      record.newIdentity = journal.identity(created); persist('created'); await checkpoint('after-create');
      persist('start-intent'); docker(['start',createdId]); await checkpoint('after-start-effect');
      const started = JSON.parse(docker(['inspect',createdId]))[0];
      if (started.Id !== createdId || started.Image !== original.Image || !started.State.Running || started.State.Pid <= 0 || /^0001-01-01T00:00:00(?:\.0+)?Z$/.test(started.State.StartedAt)) throw fail('PLACEMENT_PLATFORM_IDENTITY_CHANGED');
      record.newIdentity = journal.identity(started); persist('started'); await checkpoint('after-start'); ok = true;
    }
    return ok;
  };
  const result = await (hooks.publisher || publish)({ options, state, compose, candidate, action, docker, operation, lockFd: hooks.lockFd });
  persist('complete');
  return result;
}
async function publish({ options, state, compose, candidate, action, docker, operation, lockFd }) {
  const name = options.project + '-placement-' + operation;
  const child = spawn('docker', [...compose,'run','--rm','-T','--no-deps','--name',name,'--label','org.nightscout.replacement.operation=' + operation,
    '-v',path.join(state,'placement') + ':/run/ns-placement:rw', '-v',path.join(state,'realtime') + ':/run/ns-warm-config:ro',
    'demo','node','-r','./deploy/multitenant/load-env.js','deploy/multitenant/placement-control.js'], { stdio: ['pipe','pipe','pipe',lockFd] });
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
      const ok = await action(event);
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
