'use strict';

// Fixed roster, not dynamic discovery. One replica keeps the original UDS
// placement. Multiple replicas share a service address, while maintenance
// always reaches exact instance addresses.
function count(source = process.env) {
  const raw = source.NS_API_REPLICAS === undefined ? '1' : source.NS_API_REPLICAS;
  if (typeof raw !== 'string' || !/^[1-9][0-9]?$/.test(raw) || Number(raw) > 16) throw new TypeError('NS_API_REPLICAS must be 1..16 for this synthetic binding');
  return Number(raw);
}
const service = 'http://api-internal:7001';
const instances = n => Array.from({ length: n }, (_, i) => ({ id: 'api-' + (i + 1), service: i ? 'api-' + (i + 1) : 'api' }));
function expand(docs, n = count()) {
  if (!Number.isSafeInteger(n) || n < 1 || n > 16) throw new TypeError('Invalid fixed API replica count');
  if (n === 1) return docs;
  const original = docs.operations.api.participants.find(row => row.id === 'api');
  if (!original || docs.operations.api.participantId !== 'api') throw new TypeError('Expected unexpanded API roster');
  const nodes = instances(n);
  const peers = nodes.map(node => ({ ...original, id: node.id, address: { url: 'http://' + node.service + ':7001' } }));
  const participants = [...peers, ...docs.operations.api.participants.filter(row => row.id !== 'api')];
  const configs = { ...docs.configs }, environments = {}, operations = {};
  for (const [role, env] of Object.entries(docs.environments)) {
    const next = { ...env, NS_API_INTERNAL_URL: service }; delete next.NS_API_INTERNAL_SOCKET;
    environments[role] = next;
    operations[role] = { ...docs.operations[role], participants };
  }
  for (const node of nodes) {
    configs[node.service] = docs.configs.api;
    environments[node.service] = { ...environments.api, NS_SERVE_INTERNAL_HOST: '0.0.0.0', NS_SERVE_INTERNAL_PORT: '7001' };
    delete environments[node.service].NS_SERVE_INTERNAL_SOCKET;
    operations[node.service] = { ...docs.operations.api, participantId: node.id, participants };
  }
  const old = docs.remote.find(row => row.id === 'api');
  if (!old) throw new TypeError('Expected operator API roster');
  const remote = [...nodes.map(node => ({ ...old, id: node.id,
    endpoint: { ...old.endpoint, socketPath: undefined, url: 'http://' + node.service + ':7001/', trust: 'network' } })),
  ...docs.remote.filter(row => row.id !== 'api')];
  for (const row of remote) if (row.endpoint.socketPath === undefined) delete row.endpoint.socketPath;
  return { ...docs, configs, environments, operations, remote, apiOrigin: 'http://api-internal:1337' };
}
function compose(n = count(), composeFile = 'compose.yaml') {
  const lines = ['# Generated fixed-roster API placement.', 'services:'];
  if (n === 1) lines.push('  api: {}');
  else for (const node of instances(n)) {
    lines.push('  ' + node.service + ':');
    if (node.service !== 'api') lines.push('    extends: {file: ' + JSON.stringify(composeFile) + ', service: api}',
      '    volumes:',
      '      - ${NS_DEMO_STATE}/' + node.service + ':/run/ns-config:ro',
      '      - ${NS_DEMO_STATE}/ipc:/run/ns-ipc',
      '      - ${NS_DEMO_STATE}/tls/ca.crt:/run/ns-ca/ca.crt:ro');
    lines.push('    networks: {backend: {aliases: [api-internal]}}');
  }
  if (n > 1) lines.push('  nginx:', '    depends_on:', ...instances(n).map(node => '      ' + node.service + ': {condition: service_healthy}'));
  return lines.join('\n') + '\n';
}
module.exports = { count, expand, compose, instances, service };
