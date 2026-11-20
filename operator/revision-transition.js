#!/usr/bin/env node
'use strict';

// Offline ordinary Compose revision operations. This command never starts a
// role, changes a bootstrap marker, or silently retries an uncertain migration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fail = code => Object.assign(new Error(code), { code });
const canonical = value => JSON.stringify(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const SHA = /^[a-f0-9]{40}$/;

function privateJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid()) throw fail('REVISION_PRIVATE_FILE_REQUIRED');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validate(plan) {
  try { require('../bindings/compose/multitenant/project').validate(plan?.project); }
  catch { throw fail('REVISION_PLAN_REFUSED'); }
  if (plan?.version !== 1 || plan.profile !== 'ordinary-single' ||
      !path.isAbsolute(plan.directory || '') || !path.isAbsolute(plan.coldBackup || '') || !path.isAbsolute(plan.state || '') ||
      !Array.isArray(plan.cohort) || !plan.cohort.length || new Set(plan.cohort.map(row => row.id)).size !== plan.cohort.length ||
      !plan.cohort.every(row => /^[a-f0-9]{64}$/.test(row.id) && /^sha256:[a-f0-9]{64}$/.test(row.image)) ||
      ![plan.source, plan.target].every(row => row && path.isAbsolute(row.root || '') && SHA.test(row.sourceCommit || '') && SHA.test(row.deployCommit || '')) ||
      plan.source.sourceCommit === plan.target.sourceCommit || !plan.database ||
      !['name', 'oid', 'systemIdentifier'].every(key => typeof plan.database[key] === 'string' && plan.database[key]) ||
      !/^sha256:[a-f0-9]{64}$/.test(plan.target.image || '')) throw fail('REVISION_PLAN_REFUSED');
  return plan;
}

function sourceIdentity(source) {
  const build = require(path.join(source.root, 'deploy/multitenant/build'));
  build.assertCleanSource(source.root, source.sourceCommit);
  if (build.overlay(source.root)?.deployCommit !== source.deployCommit) throw fail('REVISION_DEPLOY_SOURCE_CHANGED');
  const envFile = path.join(source.root, 'deploy/multitenant/.env');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    if (lines.some(line => /^NS_(?:EVALUATOR_WORKERS=|REALTIME_WORKERS=)/.test(line)) || lines.some(line => line.startsWith('NS_API_REPLICAS=') && line !== 'NS_API_REPLICAS=1')) throw fail('REVISION_SELECTED_PROFILE_UNSUPPORTED');
  }
}

// Fixed ordinary binding inventory; no schema discovery, caller DDL or wildcard
// extension. The registry remains operational and travels in the cold backup.
const need = (value, code) => { if (!value) throw fail(code); };
function ordinaryAdmission(root,libraryRoot=root){
 const config=require(path.join(root,'deploy/multitenant/config')),common=require(path.join(libraryRoot,'lib/tenant-operations/common')),ops=require(path.join(libraryRoot,'lib/tenant-operations/catalogues'));
 const found=ops.discoverCatalogues(root),layout=config.layout(),namespaces={},selection={},extensions=[];
 const aliases={control:'lifecycle',rt_checkpoint:'checkpoint',eval_checkpoint:'evaluator_checkpoint',alarm:'alarm_suppression',outbox:'notification_outbox',display_settings:'tenant_settings'};
 for(const [key,candidate]of Object.entries(config.catalogues())){
  need(key!=='pool','REVISION_ADMISSION_PROFILE');if(key==='registry')continue;
  const kind=aliases[key]||key;
  if(key==='control'){namespaces[kind]=layout.namespaces[key];continue;}
  const matches=found.filter(row=>common.canonical(row.candidate)===common.canonical(candidate));need(matches.length===1,'REVISION_ADMISSION_CATALOGUE');namespaces[kind]=layout.namespaces[key];
  if(['alarm','outbox'].includes(key))extensions.push({kind,candidatePath:matches[0].file,candidateDigest:common.sha256(common.canonical(candidate)),tables:ops.createdTables(candidate)});else if(key!=='control')selection[kind]=matches[0].file;
 }
 const native=config.nativeSelection?.(layout.prefix);
 return {root,namespaces,selection,extensions,...(native?{nativeSelection:native,notificationBindings:[{namespace:layout.namespaces.outbox,consumer:require(path.join(root,'lib/server/serve/deployment-settings')).IDENTITY.realtimeConsumer}]}:{}),instances:[{kind:'evaluator_checkpoint',of:'checkpoint'}]};
}
function admission(root, libraryRoot = root) {
  return ordinaryAdmission(root, libraryRoot);
}

function stopped(plan, run = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 })) {
  const ids = run(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + plan.project]).trim().split(/\s+/).filter(Boolean);
  const all = ids.length ? JSON.parse(run(['inspect', ...ids])) : [];
  if (all.some(row => row.Config.Labels['com.docker.compose.project'] !== plan.project)) throw fail('REVISION_COHORT_CHANGED_OR_RUNNING');
  const roles = all.filter(row => !['postgres', 'vault'].includes(row.Config.Labels['com.docker.compose.service']));
  const services = roles.map(row => row.Config.Labels['com.docker.compose.service']);
  if (['api', 'evaluator', 'realtime'].some(service => services.filter(name => name === service).length !== 1) || services.some(name => /^(api|evaluator|realtime)-/.test(name))) throw fail('REVISION_SELECTED_PROFILE_UNSUPPORTED');
  if (roles.length !== plan.cohort.length || roles.some(row => row.State.Running || row.State.Restarting ||
      !plan.cohort.some(expected => expected.id === row.Id && expected.image === row.Image))) throw fail('REVISION_COHORT_CHANGED_OR_RUNNING');
}

function coldBackup(plan) {
  const manifest = privateJson(path.join(plan.coldBackup, 'manifest.json'));
  if (manifest.kind !== 'compose-cold-backup' || manifest.version !== 1 || manifest.project !== plan.project ||
      manifest.sourceCommit !== plan.source.sourceCommit || manifest.deployCommit !== plan.source.deployCommit ||
      canonical(Object.keys(manifest.files || {}).sort()) !== canonical(['deployment.env', 'postgres-data.tar', 'state.tar', 'vault-data.tar'])) throw fail('REVISION_COLD_BACKUP_MISMATCH');
  for (const [name, expected] of Object.entries(manifest.files)) {
    // Stream archives: a populated database must not be copied into the JS heap.
    const actual = execFileSync('sha256sum', ['--', path.join(plan.coldBackup, name)], { encoding: 'utf8' }).split(' ')[0];
    if (actual !== expected) throw fail('REVISION_COLD_BACKUP_DIGEST');
  }
  return digest(canonical(manifest));
}

function beginOperation(directory, command, plan, custody) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid()) throw fail('REVISION_PRIVATE_DIRECTORY_REQUIRED');
  let handle;
  try { handle = fs.openSync(path.join(directory, command + '-started.json'), 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fail('REVISION_INTERRUPTED_OR_ALREADY_RUN'); throw error; }
  try { fs.writeFileSync(handle, canonical({ version: 1, planDigest: digest(canonical(plan)), custody }) + '\n'); fs.fsyncSync(handle); }
  finally { fs.closeSync(handle); }
  const directoryHandle = fs.openSync(directory, 'r');
  try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
}

async function execute(command, plan, env = process.env) {
  validate(plan);
  if (!['preflight', 'upgrade', 'rollback', 'activate'].includes(command)) throw fail('REVISION_USAGE');
  sourceIdentity(plan.source); sourceIdentity(plan.target);
  const library = plan.target.root;
  const upgrades = require(path.join(library, 'lib/tenant-operations/upgrade'));
  const census = root => require(path.join(root, 'lib/tenant-operations/catalogues')).deploymentAdmission(admission(root)).catalogues;
  const sourceCatalogues = census(plan.source.root), catalogues = census(library);
  if (command === 'preflight') return { state: 'source-and-target-admitted', serving: false };
  stopped(plan);
  const custody = coldBackup(plan);
  if (command === 'rollback') return { state: 'restore-platform-backup', backup: plan.coldBackup,
    serving: false, next: 'Restore the paired PostgreSQL, Vault and private state backup into a fresh deployment before starting the source image.' };
  if (!env.NS_REVISION_PG) throw fail('REVISION_DIRECT_CONNECTION_REQUIRED');
  const { Client } = require(path.join(library, 'node_modules/pg'));
  const connection = new Client({ connectionString: env.NS_REVISION_PG, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  await connection.connect();
  try {
    const observed = (await connection.query("SELECT current_database() AS name,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,(SELECT system_identifier::text FROM pg_control_system()) AS \"systemIdentifier\"" )).rows[0];
    if (!['name', 'oid', 'systemIdentifier'].every(key => observed[key] === plan.database[key])) throw fail('REVISION_DATABASE_CHANGED');
    const { run } = require(path.join(library, 'lib/migrations/postgres'));
    const migrate = (action, input) => run(action, { ...input, direct: true, connectionString: env.NS_REVISION_PG });
    // wx is the interruption boundary: no automatic replay of partial DDL or a
    // restore with uncertain commit. Keep the original artifact and namespaces.
    beginOperation(plan.directory, command, plan, custody);
    let result;
    if (command === 'upgrade') result = await upgrades.upgrade(connection, { migrate, sourceCatalogues, catalogues, sourceCommit: plan.target.sourceCommit });
    else {
      const record = privateJson(path.join(plan.directory, 'upgrade-record.json'));
      upgrades.assertUpgradeCompatible(record,catalogues);
      for (const catalogue of catalogues) await migrate('check', { namespace: catalogue.namespace, catalogue: catalogue.catalogue });
      const completeFile = path.join(plan.state, 'bootstrap/complete.json'), complete = privateJson(completeFile);
      if (complete.sourceCommit !== plan.source.sourceCommit || complete.deployCommit !== plan.source.deployCommit) throw fail('REVISION_BOOTSTRAP_BINDING_CHANGED');
      // This first supported profile retains its existing configuration contract.
      // A changed generator needs a separately specified configuration transition.
      for (const file of ['config.js']) {
        if (!fs.readFileSync(path.join(plan.source.root, 'deploy/multitenant', file)).equals(fs.readFileSync(path.join(plan.target.root, 'deploy/multitenant', file)))) throw fail('REVISION_CONFIGURATION_TRANSITION_UNSUPPORTED');
      }
      const labels = JSON.parse(execFileSync('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', plan.target.image], { encoding: 'utf8' }));
      if (labels['org.opencontainers.image.revision'] !== plan.target.sourceCommit || labels['org.nightscout.deploy.revision'] !== plan.target.deployCommit) throw fail('REVISION_TARGET_IMAGE_CHANGED');
      const oldEnv = fs.readFileSync(path.join(plan.source.root, 'deploy/multitenant/.env'), 'utf8');
      for (const [key, value] of Object.entries({ NS_SOURCE_COMMIT: plan.source.sourceCommit, NS_DEPLOY_COMMIT: plan.source.deployCommit, NS_DEMO_STATE: plan.state, NS_DEMO_PROJECT: plan.project })) {
        if (!oldEnv.split('\n').includes(key + '=' + value)) throw fail('REVISION_PREPARED_BINDING_CHANGED');
      }
      const newEnv = oldEnv.replace('NS_SOURCE_COMMIT=' + plan.source.sourceCommit, 'NS_SOURCE_COMMIT=' + plan.target.sourceCommit)
        .replace('NS_DEPLOY_COMMIT=' + plan.source.deployCommit, 'NS_DEPLOY_COMMIT=' + plan.target.deployCommit);
      fs.writeFileSync(path.join(plan.target.root, 'deploy/multitenant/.env'), newEnv, { flag: 'wx', mode: 0o600 });
      const configFile = path.join(plan.state, 'ops/config.json'), config = privateJson(configFile);
      const targetPlan = require(path.join(library, 'deploy/multitenant/config'));
      const updated = { ...config, ...targetPlan.lifecycle(targetPlan.layout()) };
      fs.writeFileSync(configFile, canonical(updated) + '\n', { mode: 0o600 });
      const opsEnvFile = path.join(plan.state, 'ops/env.json'), opsEnv = privateJson(opsEnvFile);
      fs.writeFileSync(opsEnvFile, canonical({ ...opsEnv, NS_SOURCE_COMMIT: plan.target.sourceCommit }) + '\n', { mode: 0o600 });
      // Explicit recorded transition, never bootstrap's implicit source adoption.
      fs.writeFileSync(completeFile, canonical({ ...complete, sourceCommit: plan.target.sourceCommit, deployCommit: plan.target.deployCommit }) + '\n', { mode: 0o600 });
      result = { state: 'target-bound-effects-stopped', sourceCommit: plan.target.sourceCommit, coldBackupDigest: custody };
    }
    fs.writeFileSync(path.join(plan.directory, command + '-record.json'), canonical(result.record || result) + '\n', { flag: 'wx', mode: 0o600 });
    return { state: command + '-recorded-effects-stopped', serving: false };
  } finally { await connection.end(); }
}

if (require.main === module) Promise.resolve().then(() => {
  if (process.argv.length !== 4) throw fail('REVISION_USAGE');
  return execute(process.argv[2], privateJson(process.argv[3]));
}).then(result => console.log(JSON.stringify(result)), error => {
  console.error(JSON.stringify({ error: /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'REVISION_FAILED', recovery: 'Keep effects stopped. Inspect the original record, backup and namespaces; never automatically replay.' }));
  process.exitCode = 1;
});
module.exports = { validate, privateJson, admission, stopped, coldBackup, beginOperation, execute };
