'use strict';
// Stable ordinal services. No placement publication or rolling K change.
const staticOwnership = () => require('./static-ownership');
const serviceOf = ordinal => ordinal === 0 ? 'realtime' : 'realtime-' + (ordinal + 1);
function selection(source = process.env) {
  if (source.NS_REALTIME_SHARDS !== undefined) throw new TypeError('NS_REALTIME_SHARDS has retired; ownership uses the worker count');
  if (source.NS_REALTIME_WORKERS === undefined) return null;
  if (typeof source.NS_REALTIME_WORKERS !== 'string' || !/^[1-8]$/.test(source.NS_REALTIME_WORKERS)) throw new TypeError('NS_REALTIME_WORKERS must be explicit 1..8');
  return {workers: Number(source.NS_REALTIME_WORKERS)};
}
function initial(selected) { return selected ? staticOwnership().plan(selected.workers, 1) : null; }
function expand(docs, selected) {
  if (!selected) return docs;
  const shape = selected.realtime ? selected : initial(selected);
  const workers = shape.realtime, count = shape.count;
  if (!docs.configs.realtime) throw new TypeError('Expected unexpanded realtime roster');
  const environments = {}, operations = {...docs.operations}, configs = {...docs.configs};
  const privatePeers = JSON.stringify(workers.map(worker => ({socket: worker.socketPath})));
  for (const [role, env] of Object.entries(docs.environments)) {
    environments[role] = {...env};
    delete environments[role].NS_REALTIME_INTERNAL_SOCKET; delete environments[role].NS_REALTIME_INTERNAL_URL;
    if (role.startsWith('evaluator')) environments[role].NS_REALTIME_SLICE_PEERS = privatePeers;
  }
  for (const worker of workers) {
    configs[worker.service] = docs.configs.realtime;
    // Index and count as environment settings (decision statefulset-ordinal-scaling).
    environments[worker.service] = {...environments.realtime, NS_SERVE_INTERNAL_SOCKET: worker.socketPath,
      NS_SLICE_ORDINAL: String(worker.ordinal), NS_SLICE_COUNT: String(count)};
    operations[worker.service] = {...docs.operations.realtime};
  }
  return {...docs, configs, environments, operations, realtimeOwnership: shape,
    socketEdgeEnvironment: {NS_REALTIME_STATIC_COUNT: String(count), [staticOwnership().MAP]: JSON.stringify(shape.routes)}};
}
function compose(selected, composeFile) {
  if (!selected) return '';
  const shape = initial(selected), lines = ['# Fixed static realtime owners; stop all old owners before changing K.', 'services:',
    '  bootstrap:', '    environment:', '      NS_REALTIME_WORKERS: "' + selected.workers + '"'];
  for (const worker of shape.realtime) {
    lines.push('  ' + worker.service + ':', '    healthcheck:',
      '      test: [CMD, node, bin/nightscout.js, healthcheck, --endpoint, ready, --socket, ' + worker.socketPath + ']');
    if (worker.ordinal) lines.push('    extends: {file: ' + JSON.stringify(composeFile) + ', service: realtime}',
      '    volumes:', '      - ${NS_DEMO_STATE}/' + worker.service + ':/run/ns-config:ro',
      '      - ${NS_DEMO_STATE}/ipc:/run/ns-ipc', '      - ${NS_DEMO_STATE}/tls/ca.crt:/run/ns-ca/ca.crt:ro');
  }
  lines.push('  socket-edge:', '    extends: {file: ' + JSON.stringify(composeFile) + ', service: ui}',
    '    command: [node, -r, ./deploy/multitenant/load-env.js, deploy/multitenant/socket-edge.js]',
    '    environment:', '      NS_REALTIME_STATIC_COUNT: "' + shape.count + '"', '      ' + staticOwnership().MAP + ': ' + JSON.stringify(JSON.stringify(shape.routes)),
    '    healthcheck:', '      test: [CMD, node, -e, "fetch(\'http://127.0.0.1:1343/healthz\').then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})"]',
    '  nginx:', '    depends_on:', '      socket-edge: {condition: service_healthy}');
  return lines.join('\n') + '\n';
}
function services(selected) { return selected ? [...Array.from({length: selected.workers}, (_, ordinal) => serviceOf(ordinal)), 'socket-edge'] : ['realtime']; }
module.exports = {selection, initial, expand, compose, serviceOf, services};
