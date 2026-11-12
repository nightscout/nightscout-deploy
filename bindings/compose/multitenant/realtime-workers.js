'use strict';
const { randomUUID } = require('node:crypto');
function selection(source = process.env) {
  const workers = source.NS_REALTIME_WORKERS, shards = source.NS_REALTIME_SHARDS;
  if (workers === undefined && shards === undefined) return null;
  if (typeof workers !== 'string' || !/^[1-9][0-9]?$/.test(workers) || Number(workers) > 16 ||
      typeof shards !== 'string' || !/^[1-9][0-9]{0,3}$/.test(shards) || Number(shards) > 4096) throw new TypeError('Explicit NS_REALTIME_WORKERS=1..16 and NS_REALTIME_SHARDS=1..4096 required');
  return { workers: Number(workers), shards: Number(shards) };
}
const serviceOf = index => index === 0 ? 'realtime' : 'realtime-' + (index + 1);
function initial(selected) {
  if (!selected) return null;
  const workers = Array.from({ length: selected.workers }, (_, index) => ({ id: 'realtime-' + (index + 1), incarnation: randomUUID(),
    address: { socket: '/run/ns-ipc/realtime-' + (index + 1) + '.sock' }, consumerOrigin: 'http://' + serviceOf(index) + ':1339' }));
  return { version: 1, rule: 'sha256-u32be-v1', shardCount: selected.shards, generation: 1, workers,
    owners: Array.from({ length: selected.shards }, (_, index) => workers[index % workers.length].id) };
}
function expand(docs, map) {
  if (!map) return docs;
  const original = docs.operations.realtime.participants.find(row => row.roles.includes('realtime'));
  if (!original || docs.operations.realtime.participantId !== 'realtime') throw new TypeError('Expected unexpanded realtime roster');
  const workers = map.workers;
  const participants = [...docs.operations.realtime.participants.filter(row => !row.roles.includes('realtime')),
    ...workers.map(worker => ({ ...original, id: worker.id, worker: worker.id, address: worker.address }))];
  const environments = {}, operations = {}, configs = { ...docs.configs };
  for (const [role, env] of Object.entries(docs.environments)) {
    environments[role] = { ...env, MULTITENANT_REALTIME_PLACEMENT: '/run/ns-placement/backend.json', MULTITENANT_REALTIME_ROUTES: '/run/ns-placement/routes.json' };
    delete environments[role].NS_REALTIME_INTERNAL_SOCKET;
    delete environments[role].NS_REALTIME_INTERNAL_URL;
    operations[role] = { ...docs.operations[role], participants };
  }
  for (let index = 0; index < workers.length; index++) {
    const worker = workers[index], service = serviceOf(index);
    configs[service] = docs.configs.realtime;
    environments[service] = { ...environments.realtime, NS_SERVE_INTERNAL_SOCKET: worker.address.socket,
      REALTIME_WORKER_ID: worker.id, REALTIME_WORKER_INCARNATION: worker.incarnation };
    operations[service] = { ...docs.operations.realtime, participantId: worker.id, participants };
  }
  const remoteOriginal = docs.remote.find(row => row.roles.includes('realtime'));
  const remote = [...docs.remote.filter(row => !row.roles.includes('realtime')), ...workers.map(worker => ({ ...remoteOriginal,
    id: worker.id, worker: worker.id, endpoint: { socketPath: worker.address.socket, maxBytes: original.maxMessageBytes, timeoutMs: original.timeoutMs } }))];
  return { ...docs, configs, environments, operations, remote, realtimePlacement: map };
}
function compose(selected, composeFile, apiInstances = ['api']) {
  if (!selected) return '';
  const lines = ['# Fixed realtime roster with one shared assignment and admitted route view.', 'services:'];
  lines.push('  bootstrap:', '    environment:', '      NS_REALTIME_WORKERS: "' + selected.workers + '"', '      NS_REALTIME_SHARDS: "' + selected.shards + '"');
  const existing = [...apiInstances,...require('./evaluator-workers').services(require('./evaluator-workers').selection()),'tenant-admin','demo'];
  // API replica overlays also mount this directory; a merged override augments
  // every selected instance in the caller rather than relying on role aliases.
  for (const service of [...existing, ...Array.from({ length: selected.workers }, (_, index) => serviceOf(index))]) {
    lines.push('  ' + service + ':');
    if (service.startsWith('realtime-')) lines.push('    extends: {file: ' + JSON.stringify(composeFile) + ', service: realtime}',
      '    volumes:', '      - ${NS_DEMO_STATE}/' + service + ':/run/ns-config:ro', '      - ${NS_DEMO_STATE}/ipc:/run/ns-ipc',
      '      - ${NS_DEMO_STATE}/tls/ca.crt:/run/ns-ca/ca.crt:ro', '      - ${NS_DEMO_STATE}/placement:/run/ns-placement:ro');
    else lines.push('    volumes:', '      - ${NS_DEMO_STATE}/placement:/run/ns-placement:ro');
  }
  lines.push('  socket-edge:', '    extends: {file: ' + JSON.stringify(composeFile) + ', service: ui}',
    '    command: [node, -r, ./deploy/multitenant/load-env.js, deploy/multitenant/socket-edge.js]',
    '    environment:', '      MULTITENANT_REALTIME_ROUTES: /run/ns-placement/routes.json',
    '    volumes:', '      - ${NS_DEMO_STATE}/placement:/run/ns-placement:ro',
    '    healthcheck:', '      test: [CMD, node, -e, "fetch(\'http://127.0.0.1:1343/healthz\').then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})"]',
    '  nginx:', '    depends_on:', '      socket-edge: {condition: service_healthy}');
  return lines.join('\n') + '\n';
}
function services(selected) { return selected ? [...Array.from({ length: selected.workers }, (_, index) => serviceOf(index)), 'socket-edge'] : ['realtime']; }
module.exports = { selection, initial, expand, compose, serviceOf, services };
