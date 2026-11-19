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
function compose(selected, composeFile) {
  if (!selected) return '';
  const shape = initial(selected), lines = ['# Fixed static realtime owners; stop all old owners before changing K.', 'services:',
    '  bootstrap:', '    environment:', '      NS_REALTIME_WORKERS: "' + selected.workers + '"'];
  const peers = shape.realtime.map(worker => ({ socket: worker.socketPath }));
  lines.push('  evaluator:', '    environment:', '      NS_REALTIME_SLICE_PEERS: ' + JSON.stringify(JSON.stringify(peers)));
  for (const worker of shape.realtime) {
    lines.push('  ' + worker.service + ':', '    environment:',
      '      NS_SERVE_INTERNAL_SOCKET: ' + worker.socketPath, '      NS_REALTIME_INTERNAL_SOCKET: ' + worker.socketPath,
      '      NS_SLICE_ORDINAL: "' + worker.ordinal + '"', '      NS_SLICE_COUNT: "' + shape.count + '"',
      '    healthcheck:',
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
module.exports = {selection, initial, compose, serviceOf, services};
