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
    lines.push('    environment:', '      NS_API_INTERNAL_SOCKET: ""', '      NS_API_INTERNAL_URL: ' + service,
      '      NS_SERVE_INTERNAL_SOCKET: ""', '      NS_SERVE_INTERNAL_HOST: 0.0.0.0', '      NS_SERVE_INTERNAL_PORT: "7001"');
    lines.push('    healthcheck:', '      test: [CMD, node, bin/nightscout.js, healthcheck, --endpoint, ready, --url, http://127.0.0.1:7001/healthz/ready]');
    lines.push('    networks: {backend: {aliases: [api-internal]}}');
  }
  if (n > 1) for (const role of ['evaluator', 'realtime', 'tenant-admin']) lines.push('  ' + role + ':',
    '    environment:', '      NS_API_INTERNAL_SOCKET: ""', '      NS_API_INTERNAL_URL: ' + service);
  if (n > 1) lines.push('  nginx:', '    depends_on:', ...instances(n).map(node => '      ' + node.service + ': {condition: service_healthy}'));
  return lines.join('\n') + '\n';
}
module.exports = { count, compose, instances, service };
