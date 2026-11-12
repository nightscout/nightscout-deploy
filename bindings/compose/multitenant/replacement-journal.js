'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesDigest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function privateJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 1048576) fail('PLACEMENT_PRIVATE_FILE_REQUIRED');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function atomicJson(file, value, create = false) {
  if (!create || fs.existsSync(file)) privateJson(file);
  const temporary = path.join(path.dirname(file), '.intent-' + crypto.randomBytes(12).toString('hex'));
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
async function locked(state, run) {
  // flock locks the shared open-file description. The parent retains fd3's
  // description after flock exits; the kernel releases it on crash/last close.
  if (fs.realpathSync(state) !== path.resolve(state) || fs.realpathSync(path.join(state, 'placement')) !== path.join(path.resolve(state), 'placement')) fail('PLACEMENT_PRIVATE_FILE_REQUIRED');
  const file = path.join(state, 'placement/operation.lock');
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || stat.nlink !== 1 || stat.uid !== process.getuid()) fail('PLACEMENT_PRIVATE_FILE_REQUIRED');
    try { execFileSync('flock', ['--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }); }
    catch { fail('PLACEMENT_HOST_OPERATION_BUSY'); }
    return await run(fd);
  } finally { fs.closeSync(fd); }
}
const identity = row => ({ id: row.Id, startedAt: row.State.StartedAt, pid: row.State.Pid });
function sameProcess(row, known) {
  if (row.Id !== known.id || row.State.StartedAt !== known.startedAt || row.State.Running && row.State.Pid !== known.pid) fail('PLACEMENT_PLATFORM_IDENTITY_CHANGED');
}
const phases = ['prepared','stop-intent','stopped','env-intent','env-written','create-intent','created','start-intent','started','complete'];
function recoverable(journal, { project, state, worker, complete, authority, compose, backend, routes, env, row }) {
  if (journal.version !== 1 || !/^[a-f0-9]{32}$/.test(journal.operation || '') || !phases.includes(journal.phase) || journal.phase === 'complete' ||
      journal.project !== project || journal.state !== state || journal.worker !== worker || journal.source.core !== complete.sourceCommit || journal.source.deploy !== complete.deployCommit ||
      JSON.stringify(journal.authority) !== JSON.stringify(authority) || !authority || !/^[a-f0-9]{64}$/.test(authority.sha256) || journal.image !== row.Image || JSON.stringify(journal.compose) !== JSON.stringify(compose)) fail('PLACEMENT_RECOVERY_IDENTITY_CHANGED');
  const map = digest(backend), route = digest(routes), boot = digest(env);
  if (![journal.beforeDigest, journal.candidateDigest].includes(map) || ![journal.routesDigest, journal.candidateDigest].includes(route) ||
      route === journal.candidateDigest && map !== journal.candidateDigest || ![journal.oldEnvDigest, journal.newEnvDigest].includes(boot)) fail('PLACEMENT_RECOVERY_STATE_CHANGED');
  const at = phases.indexOf(journal.phase);
  if (row.Id === journal.oldIdentity.id) {
    sameProcess(row, journal.oldIdentity);
    if (at >= phases.indexOf('created') || at >= phases.indexOf('stopped') && row.State.Running) fail('PLACEMENT_RECOVERY_PROCESS_AMBIGUOUS');
    // No start of the intended incarnation can precede its durable start intent,
    // and the original container still exists. Its intended boot never ran.
    return { neverActivated: true, published: map === journal.candidateDigest };
  }
  const labels = row.Config.Labels || {};
  if (at < phases.indexOf('create-intent') || labels['org.nightscout.replacement.operation'] !== journal.operation ||
      labels['org.nightscout.replacement.incarnation'] !== journal.newIncarnation || boot !== journal.newEnvDigest) fail('PLACEMENT_RECOVERY_PROCESS_AMBIGUOUS');
  if (journal.newIdentity && row.Id !== journal.newIdentity.id) fail('PLACEMENT_PLATFORM_IDENTITY_CHANGED');
  if (at < phases.indexOf('start-intent') && (row.State.Running || !/^0001-01-01T00:00:00(?:\.0+)?Z$/.test(row.State.StartedAt))) fail('PLACEMENT_RECOVERY_PROCESS_AMBIGUOUS');
  if (at >= phases.indexOf('started')) sameProcess(row, journal.newIdentity);
  if (journal.activation && bytesDigest(journal.activation.path) !== journal.activation.sha256) fail('PLACEMENT_RECOVERY_STATE_CHANGED');
  return { neverActivated: at < phases.indexOf('start-intent'), published: map === journal.candidateDigest };
}
module.exports = { fail, digest, bytesDigest, privateJson, atomicJson, locked, identity, sameProcess, phases, recoverable };
