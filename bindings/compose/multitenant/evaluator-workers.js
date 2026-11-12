'use strict';

// A fixed serving roster; desired membership remains an operator revision in
// the pool store, never an ambient per-worker member-count setting.
function selection(source = process.env) {
  const raw = source.NS_EVALUATOR_WORKERS;
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !/^[1-9][0-9]?$/.test(raw) || Number(raw) > 16) throw new TypeError('NS_EVALUATOR_WORKERS must be explicit 1..16');
  return { workers: Number(raw) };
}
const serviceOf = index => index === 0 ? 'evaluator' : 'evaluator-' + (index + 1);
function services(selected) { return selected ? Array.from({ length: selected.workers }, (_, index) => serviceOf(index)) : ['evaluator']; }
function expand(docs, { layout, urls }, selected = selection()) {
  if (!selected) return docs;
  const original = docs.operations.evaluator.participants.find(row => row.roles.includes('evaluator'));
  if (!original || !docs.admin) throw new TypeError('Evaluator pool requires registry infrastructure');
  const workers = services(selected).map((service, ordinal) => ({ service, ordinal, id: 'evaluator-' + (ordinal + 1), address: { socket: '/run/ns-ipc/evaluator-' + (ordinal + 1) + '.sock' } }));
  const participants = [...docs.operations.evaluator.participants.filter(row => !row.roles.includes('evaluator')),
    ...workers.map(worker => ({ ...original, namespaces: [...new Set([...original.namespaces,layout.namespaces.pool])].sort(), id: worker.id, address: worker.address }))];
  for (const operation of Object.values(docs.operations)) operation.participants = participants;
  for (const worker of workers) {
    docs.configs[worker.service] = docs.configs.evaluator;
    docs.environments[worker.service] = { ...docs.environments.evaluator, NS_SERVE_INTERNAL_SOCKET: worker.address.socket,
      MULTITENANT_POOL_EVALUATOR_PARTITION: 'on', MULTITENANT_POOL_EVALUATOR_ORDINAL: String(worker.ordinal),
      MULTITENANT_POOL_EVALUATOR_DATABASE_URL: urls.pool_member, MULTITENANT_POOL_EVALUATOR_NAMESPACE: layout.namespaces.pool };
    delete docs.environments[worker.service].NS_EVALUATOR_INTERNAL_SOCKET;
    docs.operations[worker.service] = { ...docs.operations.evaluator, participantId: worker.id, participants };
  }
  const remote = docs.remote.find(row => row.roles.includes('evaluator'));
  docs.remote = [...docs.remote.filter(row => !row.roles.includes('evaluator')), ...workers.map(worker => ({ ...remote,
    id: worker.id, namespaces: [...new Set([...remote.namespaces,layout.namespaces.pool])].sort(), endpoint: { socketPath: worker.address.socket, maxBytes: original.maxMessageBytes, timeoutMs: original.timeoutMs } }))];
  docs.admin.config.pools = { connectionEnv: 'NS_POOL_OPERATOR_PG', namespace: layout.namespaces.pool, kinds: ['evaluator'] };
  docs.admin.environment.NS_POOL_OPERATOR_PG = urls.pool_operator;
  docs.evaluatorPool = selected;
  return docs;
}
function compose(selected, composeFile) {
  if (!selected) return '';
  const lines = ['# Independent fixed evaluator roster; operator owns desired membership.', 'services:', '  bootstrap:', '    environment:', '      NS_EVALUATOR_WORKERS: "' + selected.workers + '"'];
  for (const service of services(selected).slice(1)) lines.push('  ' + service + ':',
    '    extends: {file: ' + JSON.stringify(composeFile) + ', service: evaluator}',
    '    volumes:', '      - ${NS_DEMO_STATE}/' + service + ':/run/ns-config:ro', '      - ${NS_DEMO_STATE}/ipc:/run/ns-ipc', '      - ${NS_DEMO_STATE}/tls/ca.crt:/run/ns-ca/ca.crt:ro');
  return lines.join('\n') + '\n';
}
module.exports = { selection, services, serviceOf, expand, compose };
