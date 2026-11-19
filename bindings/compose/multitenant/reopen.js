'use strict';

// Host entry for a prepared synthetic Compose fixture. Keep its existing
// volumes, generated credentials, project, networks and static role roster.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const build = require('./build');
const project = require('./project');
const refuse = code => { throw new Error(code); };
function prepared(file) {
  if (!path.isAbsolute(file) || path.basename(file) !== '.env' || fs.realpathSync(file) !== file ||
      (fs.statSync(file).mode & 0o077)) refuse('SEED_PATCH_PRIVATE_ENV_REQUIRED');
  const entries = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => {
    const match = /^(NS_[A-Z0-9_]+)=([A-Za-z0-9_:./@-]*)$/.exec(line);
    if (!match) refuse('SEED_PATCH_PREPARED_ENV_INVALID');
    return match.slice(1);
  });
  const env = Object.fromEntries(entries);
  if (Object.keys(env).length !== entries.length || !path.isAbsolute(env.NS_DEMO_STATE || '') ||
      fs.realpathSync(env.NS_DEMO_STATE) !== env.NS_DEMO_STATE ||
      ![env.NS_SOURCE_COMMIT, env.NS_DEPLOY_COMMIT].every(v => /^[a-f0-9]{40}$/.test(v || ''))) refuse('SEED_PATCH_PREPARED_ENV_INVALID');
  project.validate(env.NS_DEMO_PROJECT);
  return env;
}
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore','pipe','pipe'] }).trim();
function stoppedFixture(env) {
  const ids = docker(['ps','-aq','--filter','label=com.docker.compose.project=' + env.NS_DEMO_PROJECT]).split(/\s+/).filter(Boolean);
  const rows = ids.length ? JSON.parse(docker(['inspect', ...ids])) : [];
  const infra = {};
  for (const [service, dest, file] of [['postgres','/run/secrets/postgres-password','bootstrap/postgres-password'],
    ['vault','/vault/config/demo.hcl','vault/demo.hcl']]) {
    const matches = rows.filter(row => row.Config.Labels['com.docker.compose.service'] === service);
    if (matches.length !== 1 || !matches[0].Mounts.some(m => m.Destination === dest && m.Type === 'bind' && !m.RW &&
      m.Source === path.join(env.NS_DEMO_STATE, file))) refuse('SEED_PATCH_FIXTURE_CUSTODY_CHANGED');
    infra[service] = matches[0];
  }
  if (rows.some(row => row.State.Restarting || row.State.Paused || row.State.Running && !Object.values(infra).includes(row))) refuse('SEED_PATCH_STOP_ROLES_FIRST');
  return infra;
}
// Compose resolves extends.file against the first -f file. Older prepare
// versions wrote that file's absolute path into the fixed-worker overlays.
function portableOverlays(state, previousDirectory) {
  const previous = 'extends: {file: ' + JSON.stringify(path.join(previousDirectory, 'compose.yaml')) + ', service:';
  for (const name of ['compose.replicas.yaml','compose.realtime.yaml','compose.evaluator.yaml']) {
    const file = path.join(state, name);
    if (!fs.existsSync(file)) continue;
    const original = fs.readFileSync(file, 'utf8');
    const portable = original.replaceAll(previous, 'extends: {file: "compose.yaml", service:');
    if (portable === original) continue;
    const temporary = file + '.patch-' + process.pid;
    fs.writeFileSync(temporary, portable, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}
function reopen(previousFile, image) {
  const env = prepared(previousFile);
  const state = env.NS_DEMO_STATE;
  const fd = fs.openSync(state, 'r');
  try {
    execFileSync('flock', ['-n','3'], { stdio: ['ignore','ignore','ignore',fd] });
    const infra = stoppedFixture(env);
    const root = path.resolve(__dirname, '../..');
    const source = build.assertCleanSource(root);
    const deploy = build.overlay(root)?.deployCommit || source;
    const selected = JSON.parse(docker(['image','inspect','--format','{{json .}}','--',image]));
    const labels = selected.Config.Labels || {};
    if (labels['org.opencontainers.image.revision'] !== source || labels['org.nightscout.deploy.revision'] !== deploy) refuse('SEED_PATCH_IMAGE_CHANGED');
    const complete = JSON.parse(fs.readFileSync(path.join(state, 'bootstrap/complete.json'), 'utf8'));
    const prior = complete.patch?.from || complete;
    if (!((prior.sourceCommit === env.NS_SOURCE_COMMIT && prior.deployCommit === env.NS_DEPLOY_COMMIT) ||
          (prior.sourceCommit === source && prior.deployCommit === deploy) ||
          (complete.patch && env.NS_SOURCE_COMMIT === source && env.NS_DEPLOY_COMMIT === deploy)) ||
        complete.patch && (complete.patch.target.sourceCommit !== source || complete.patch.target.deployCommit !== deploy)) refuse('SEED_PATCH_REVISION_MISMATCH');
    const targetFile = path.join(__dirname, '.env');
    if (fs.existsSync(targetFile)) {
      const existing = prepared(targetFile);
      if (existing.NS_DEMO_STATE !== state || existing.NS_DEMO_PROJECT !== env.NS_DEMO_PROJECT) refuse('SEED_PATCH_TARGET_ALREADY_PREPARED');
    }
    const next = { ...env, NS_SOURCE_COMMIT: source, NS_DEPLOY_COMMIT: deploy, NS_DEMO_IMAGE: selected.Id,
      NS_POSTGRES_IMAGE: infra.postgres.Image };
    portableOverlays(state, path.dirname(previousFile));
    const temporary = targetFile + '.patch-' + process.pid;
    fs.writeFileSync(temporary, Object.entries(next).map(([k,v]) => k + '=' + v + '\n').join(''), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, targetFile);
    execFileSync('./demo.sh', ['up'], {
      cwd: __dirname, env: { ...process.env, ...next }, stdio: 'inherit'
    });
  } finally { fs.closeSync(fd); }
}
if (require.main === module) {
  try {
    if (process.argv.length !== 4) refuse('SEED_PATCH_USAGE');
    reopen(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'SEED_PATCH_REFUSED');
    process.exitCode = 1;
  }
}
module.exports = { prepared, stoppedFixture };
