'use strict';

const PORT = 19913;
const PROFILE = 'NS_PGSTREAM_EVALUATOR_SLICE';

function selection(source = process.env) {
  const raw = source.NS_EVALUATOR_WORKERS;
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !/^[1-8]$/.test(raw)) throw new TypeError('NS_EVALUATOR_WORKERS must be explicit 1..8');
  return { workers: Number(raw) };
}

const serviceOf = index => index === 0 ? 'evaluator' : 'evaluator-' + (index + 1);
function services(selected) {
  return Array.from({ length: selected?.workers ?? 1 }, (_, index) => serviceOf(index));
}

function roster(selected) {
  return services(selected).map((service, index) => ({
    service, id: 'evaluator-' + (index + 1), url: 'http://' + service + ':' + PORT + '/',
    socket: '/run/ns-ipc/evaluator-' + (index + 1) + '.sock'
  }));
}

function assertSeed(selected) {
  if (!selected) return;
  if (typeof require('../../lib/pgstream/assigned-worker').processProfile !== 'function') throw new Error('PGSTREAM_EVALUATOR_PROCESS_SOURCE_REQUIRED');
  // Idle ordinals are valid: registry live-add is not a topology change.
}

function expand(docs, selected) {
  if (!selected) return docs;
  const workers = roster(selected), receivers = workers.map(worker => worker.url);
  const evaluator = docs.configs.evaluator, operation = docs.operations.evaluator;
  const original = operation.participants.find(row => row.id === 'evaluator');
  const remote = docs.remote.find(row => row.id === 'evaluator');
  const participants = [
    ...operation.participants.filter(row => row !== original),
    ...workers.map(({id, socket}) => ({ ...original, id, address: { socket } }))
  ];
  for (const value of Object.values(docs.operations)) value.participants = participants;
  for (const env of Object.values(docs.environments)) delete env.NS_EVALUATOR_INTERNAL_SOCKET;
  const baseEnvironment = docs.environments.evaluator;
  for (const [ordinal, {service, id, url, socket}] of workers.entries()) {
    docs.configs[service] = {
      ...evaluator, pgstream: { ...evaluator.pgstream, receiver: { ...evaluator.pgstream.receiver, url } }
    };
    docs.environments[service] = {
      ...baseEnvironment, NS_SERVE_INTERNAL_SOCKET: socket,
      NS_POOL_EVALUATOR_MAX: '4', NS_POOL_OPERATION_MAX: '8',
      [PROFILE]: JSON.stringify({ count: workers.length, ordinal, receivers })
    };
    docs.operations[service] = { ...operation, participantId: id };
  }
  docs.remote = [...docs.remote.filter(row => row !== remote), ...workers.map(({id, socket}) => ({
    ...remote, id, endpoint: { ...remote.endpoint, socketPath: socket }
  }))];
  docs.evaluatorWorkers = selected;
  return docs;
}

function validate(docs, role, parsed, operation) {
  if (!docs.evaluatorWorkers) return;
  const workers = roster(docs.evaluatorWorkers);
  const peers = operation.participants.filter(row => row.roles.includes('evaluator'));
  if (peers.length !== workers.length || workers.some(({id, socket}) => !peers.some(row => row.id === id && row.endpoint.socketPath === socket))) {
    throw new TypeError('Deployment evaluator participant coverage mismatch');
  }
  const ordinal = workers.findIndex(worker => worker.service === role);
  if (ordinal === -1) return;
  const primary = docs.configs.evaluator;
  if (operation.participantId !== workers[ordinal].id || parsed.processAssignment?.ordinal !== ordinal ||
      JSON.stringify(parsed.processAssignment.receivers) !== JSON.stringify(workers.map(worker => worker.url)) ||
      parsed.consumer !== primary.consumer || parsed.pgstream.slot !== primary.pgstream.slot ||
      parsed.pgstream.generation !== primary.pgstream.generation || parsed.pgstream.streamRole !== primary.pgstream.streamRole) {
    throw new TypeError('Deployment evaluator native source or assignment mismatch');
  }
}

function compose(selected, composeFile, tenantCount) {
  if (!selected) return '';
  const workers = services(selected);
  const limits = ['    cpus: 1', '    mem_limit: 1g'];
  const lines = ['# Fixed native evaluator processes.', 'services:', '  bootstrap:', '    environment:',
    '      NS_EVALUATOR_WORKERS: "' + selected.workers + '"',
    '      NS_DEMO_TENANTS: "' + tenantCount + '"', '  pgstream:', '    cpus: 1', '    mem_limit: 512m',
    '    depends_on:', ...workers.map(service => '      ' + service + ': {condition: service_started}'),
    '    restart: unless-stopped', '  evaluator:', '    restart: unless-stopped', ...limits];
  for (const service of workers.slice(1)) lines.push('  ' + service + ':',
    '    extends: {file: ' + JSON.stringify(composeFile) + ', service: evaluator}', '    restart: unless-stopped', ...limits,
    '    volumes:', '      - ${NS_DEMO_STATE}/' + service + ':/run/ns-config:ro',
    '      - ${NS_DEMO_STATE}/ipc:/run/ns-ipc', '      - ${NS_DEMO_STATE}/tls/ca.crt:/run/ns-ca/ca.crt:ro');
  return lines.join('\n') + '\n';
}

module.exports = { selection, services, roster, assertSeed, expand, validate, compose };
