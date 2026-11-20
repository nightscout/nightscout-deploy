#!/usr/bin/env node
'use strict';

// Local preparation only: no Docker calls, network changes or database access.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const base = __dirname;
function prepare (args) {
  const transport = require('./input-transport'), mode = transport.selection();
  const project = require('./project');
  const options = {project:project.DEFAULT, bind: '127.0.0.1', port: '18080', state: path.join(base, '.state')};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    if (!['--bind', '--port', '--state', '--project', '--backend-subnet', '--edge-subnet'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid preparation arguments');
    options[key] = args[i + 1];
  }
  project.validate(options.project);
  const selectedNetworks=require('./networks').select(options['backend-subnet'],options['edge-subnet']);
  if (!['127.0.0.1', '169.254.1.1'].includes(options.bind) ||
      !Object.values(os.networkInterfaces()).flat().some(row => row.address === options.bind)) {
    throw new Error('Bind address must already exist: 127.0.0.1 or 169.254.1.1');
  }
  if (!/^[0-9]+$/.test(options.port) || Number(options.port) < 1024 || Number(options.port) > 65535) throw new Error('Invalid unprivileged port');
  const state = path.resolve(options.state);
  if (!/^\/[A-Za-z0-9_./-]+$/.test(state) || state.split('/').includes('..')) throw new Error('State path must be absolute without spaces or shell syntax');
  let ancestor = path.dirname(state);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== ancestor) throw new Error('State path must not traverse symlink ancestors');
  const sourceRoot = path.resolve(base, '../..');
  if (state.startsWith(sourceRoot + '/') && state !== path.join(base, '.state')) throw new Error('Custom state must be outside the source/build context');
  if (fs.existsSync(state) || fs.existsSync(path.join(base, '.env'))) throw new Error('State or deployment .env already exists; reuse it or choose a clean deployment checkout');
  const replicas = require('./replicas');
  const apiReplicas = replicas.count();
  const realtime = require('./realtime-workers'), selectedRealtime = realtime.selection();
  const diagnostics = require('./diagnostics').selection();
  const evaluator = require('./evaluator-workers'), selectedEvaluator = evaluator.selection();
  if (selectedRealtime && selectedEvaluator && selectedRealtime.workers !== selectedEvaluator.workers) throw new TypeError('Static role counts must agree');
  if (selectedEvaluator) evaluator.assertSeed(selectedEvaluator);
  require('./edge').policy();
  const isolation = require('./clinical-isolation');
  const clinicalIsolation = isolation.selection(process.env, { budget: isolation.connectionBudget({ apiReplicas,
    realtimeWorkers: selectedRealtime?.workers ?? 1, evaluatorWorkers: selectedEvaluator?.workers ?? 1 }) });
  const source = require('./build').assertCleanSource(path.join(base, '../..'));
  const deployCommit = require('./build').overlay(path.join(base, '../..'))?.deployCommit || source;
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Source commit unavailable');
  fs.mkdirSync(state, {mode: 0o700});
  const write = (file, value) => fs.writeFileSync(file, value, {mode: 0o600, flag: 'wx'});
  for (const name of ['bootstrap', 'tls', 'vault', 'ipc', 'artifacts', 'api', 'realtime', 'evaluator', 'pgstream', 'tenant-admin', 'ui', 'ops', 'edge', 'admin', 'primer']) {
    fs.mkdirSync(path.join(state, name), {mode: 0o700});
  }
  write(path.join(state, 'bootstrap/postgres-password'), crypto.randomBytes(32).toString('hex') + '\n');
  // Every role credential exists before the first up (decision provisioning-secrets-in).
  require('./credentials').seed(path.join(state, 'credentials'));
  const tls = path.join(state, 'tls');
  const openssl = args => execFileSync('openssl', args, {cwd: tls, stdio: ['ignore', 'ignore', 'pipe']});
  openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '30', '-subj', '/CN=Nightscout synthetic Compose CA']);
  openssl(['req', '-newkey', 'rsa:3072', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=vault']);
  write(path.join(tls, 'server.ext'), 'subjectAltName=DNS:vault\nextendedKeyUsage=serverAuth\n');
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '30', '-extfile', 'server.ext']);
  for (const name of fs.readdirSync(tls)) fs.chmodSync(path.join(tls, name), name.endsWith('.crt') ? 0o644 : 0o600);
  // The Vault image drops to its own service uid. Only the server key is mounted
  // separately by Compose; CA signing material stays in bootstrap custody.
  fs.chmodSync(path.join(tls, 'server.key'), 0o644);
  write(path.join(state, 'vault/demo.hcl'), 'disable_mlock = true\nui = false\napi_addr = "https://vault:8200"\nstorage "file" { path = "/vault/file" }\nlistener "tcp" {\n  address = "0.0.0.0:8200"\n  tls_cert_file = "/run/ns-tls/server.crt"\n  tls_key_file = "/run/ns-tls/server.key"\n}\n');
  fs.chmodSync(path.join(state, 'vault/demo.hcl'), 0o644);
  if (selectedRealtime) {
    for (const service of realtime.services(selectedRealtime).filter(name => name.startsWith('realtime-'))) fs.mkdirSync(path.join(state, service), {mode: 0o700});
    write(path.join(state, 'compose.realtime.yaml'), realtime.compose(selectedRealtime, 'compose.yaml', replicas.instances(apiReplicas).map(node => node.service)));
  }
  if (selectedEvaluator) {
    for (const service of evaluator.services(selectedEvaluator).slice(1)) fs.mkdirSync(path.join(state, service), {mode: 0o700});
    write(path.join(state, 'compose.evaluator.yaml'), evaluator.compose(selectedEvaluator, 'compose.yaml'));
  }
  write(path.join(state, 'edge/nginx.conf'), require('./edge').render(fs.readFileSync(path.join(base, 'nginx.compose.conf'), 'utf8'), { replicas: apiReplicas, realtime: !!selectedRealtime }));
  write(path.join(state, 'compose.replicas.yaml'), replicas.compose(apiReplicas, 'compose.yaml')+require('./networks').render(selectedNetworks));
  if (mode === 'writer-driven') write(path.join(state, 'compose.writer.yaml'), transport.compose(apiReplicas, selectedEvaluator, selectedRealtime));
  write(path.join(base, '.env'), (mode === 'writer-driven' ? 'NS_INPUT_TRANSPORT=writer-driven' : 'NS_PGSTREAM=1')+'\nNS_DEPLOY_COMMIT=' + deployCommit + '\nNS_DEMO_PROJECT=' + options.project + '\nNS_API_REPLICAS=' + apiReplicas + '\n' +
    (selectedRealtime ? 'NS_REALTIME_WORKERS=' + selectedRealtime.workers + '\n' : '') +
    (selectedEvaluator ? 'NS_EVALUATOR_WORKERS=' + selectedEvaluator.workers + '\nNS_PGSTREAM_WAL_SENDERS=' + Math.max(4, selectedEvaluator.workers + 2) + '\n' : '') +
    'NS_M7_DIAGNOSTICS=' + diagnostics.enabled + '\nNS_M7_DIAGNOSTICS_INTERVAL_MS=' + diagnostics.interval + '\n' +
    require('./clinical-isolation').envLines(clinicalIsolation) +
    'NS_DEMO_STATE=' + state + '\nNS_DEMO_BIND=' + options.bind + '\nNS_DEMO_PORT=' + options.port + '\nNS_SOURCE_COMMIT=' + source + '\n');
  process.stdout.write('Prepared private synthetic deployment state. Start it with one up.\n');
  process.stdout.write(JSON.stringify({ inputTransport: mode, apiReplicas, evaluatorSlices: selectedEvaluator?.workers ?? 1, realtimeSlices: selectedRealtime?.workers ?? 1, coreCommit: source, deployCommit, fixture: 'fresh' }) + '\n');
  return {state, source};
}
if (require.main === module) {
  try { prepare(process.argv.slice(2)); } catch (error) {
    process.stderr.write('Preparation refused: ' + (error.status ? 'local TLS generation failed' : error.message) + '\n');
    process.exitCode = 1;
  }
}
module.exports = {prepare};
