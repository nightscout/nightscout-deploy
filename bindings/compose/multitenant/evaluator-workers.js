'use strict';

// Decision statefulset-ordinal-scaling: each evaluator reads its ordinal from its hostname
// (evaluator-<i>) and K from NS_EVALUATOR_SLICES. Evaluator i is the StatefulSet DNS name
// evaluator-<i>.evaluator; Compose gives each service that hostname and that name as a network
// alias, so both platforms take one path. K=1 is the unsliced single evaluator.
// The one evaluator K bound. The Kubernetes binding's assert and input schema, its seed script and
// the capacity harness's progress reader are checked against it (bindings/kubernetes/check).
const MAX_WORKERS = 8;

function selection(source = process.env) {
  const raw = source.NS_EVALUATOR_WORKERS;
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_WORKERS) throw new TypeError('NS_EVALUATOR_WORKERS must be explicit 1..' + MAX_WORKERS);
  return { workers: Number(raw) };
}

const serviceOf = index => index === 0 ? 'evaluator' : 'evaluator-' + (index + 1);
function services(selected) {
  return Array.from({ length: selected?.workers ?? 1 }, (_, index) => serviceOf(index));
}

const sliced = selected => (selected?.workers ?? 1) > 1;
function roster(selected) {
  return services(selected).map((service, index) => ({
    service, id: 'evaluator-' + (index + 1), hostname: 'evaluator-' + index,
    alias: sliced(selected) ? 'evaluator-' + index + '.evaluator' : service,
    socket: '/run/ns-ipc/evaluator-' + (index + 1) + '.sock'
  }));
}

function compose(selected, composeFile) {
  if (!selected) return '';
  const workers = services(selected);
  const lines = ['# Fixed native evaluator processes.', 'services:', '  bootstrap:', '    environment:',
    '      NS_EVALUATOR_WORKERS: "' + selected.workers + '"'];
  for (const [ordinal, item] of roster(selected).entries()) {
    const { service, hostname, alias, socket } = item;
    lines.push('  ' + service + ':', '    restart: unless-stopped', '    environment:',
      '      NS_SERVE_INTERNAL_SOCKET: ' + socket, '      NS_EVALUATOR_INTERNAL_SOCKET: ' + socket);
    if (sliced(selected)) lines.push('      NS_EVALUATOR_SLICES: "' + workers.length + '"', '    hostname: ' + hostname,
      '    networks: {backend: {aliases: [' + alias + ']}}');
    lines.push('    healthcheck:', '      test: [CMD, node, bin/nightscout.js, healthcheck, --endpoint, ready, --socket, ' + socket + ']');
    if (ordinal > 0) lines.push('    extends: {file: ' + JSON.stringify(composeFile) + ', service: evaluator}',
      '    volumes:', '      - ${NS_DEMO_STATE}/' + service + ':/run/ns-config:ro',
      '      - ${NS_DEMO_STATE}/ipc:/run/ns-ipc', '      - ${NS_DEMO_STATE}/tls/ca.crt:/run/ns-ca/ca.crt:ro');
  }
  return lines.join('\n') + '\n';
}

module.exports = { MAX_WORKERS, selection, services, roster, compose };
