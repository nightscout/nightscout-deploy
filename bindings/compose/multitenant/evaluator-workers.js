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

function compose(selected, composeFile) {
  if (!selected) return '';
  const workers = services(selected);
  const lines = ['# Fixed native evaluator processes.', 'services:', '  bootstrap:', '    environment:',
    '      NS_EVALUATOR_WORKERS: "' + selected.workers + '"',
    '  pgstream:',
    '    depends_on:', ...workers.map(service => '      ' + service + ': {condition: service_started}'),
    '    restart: unless-stopped'];
  for (const [ordinal, item] of roster(selected).entries()) {
    const { service, url, socket } = item;
    lines.push('  ' + service + ':', '    restart: unless-stopped', '    environment:',
      '      NS_SERVE_INTERNAL_SOCKET: ' + socket, '      NS_EVALUATOR_INTERNAL_SOCKET: ' + socket,
      '      NS_PGSTREAM_RECEIVER_URL: ' + url,
      '      NS_PGSTREAM_EVALUATOR_SLICE: ' + JSON.stringify(JSON.stringify({ count: workers.length, ordinal, receivers: roster(selected).map(r => r.url) })),
      '    healthcheck:', '      test: [CMD, node, bin/nightscout.js, healthcheck, --endpoint, ready, --socket, ' + socket + ']');
    if (ordinal > 0) lines.push('    extends: {file: ' + JSON.stringify(composeFile) + ', service: evaluator}',
      '    volumes:', '      - ${NS_DEMO_STATE}/' + service + ':/run/ns-config:ro',
      '      - ${NS_DEMO_STATE}/ipc:/run/ns-ipc', '      - ${NS_DEMO_STATE}/tls/ca.crt:/run/ns-ca/ca.crt:ro');
  }
  return lines.join('\n') + '\n';
}

module.exports = { selection, services, roster, assertSeed, compose };
