'use strict';

// Synthetic reference defaults, independent of an application's socket count.
// The operator can size these per-client-IP budgets for the measured topology.
// Existing Engine.IO sessions do not consume the new-handshake rate budget.
const DEFAULTS = Object.freeze({ connections: 50000, rate: 5000, burst: 10000, workerConnections: 16384 });
function policy(source = process.env) {
  const names = { connections: 'NS_EDGE_CONNECTIONS_PER_IP', rate: 'NS_EDGE_HANDSHAKES_PER_SECOND', burst: 'NS_EDGE_HANDSHAKE_BURST', workerConnections: 'NS_EDGE_WORKER_CONNECTIONS' };
  return Object.fromEntries(Object.entries(names).map(([kind, name]) => {
    const raw = source[name] === undefined ? String(DEFAULTS[kind]) : source[name];
    const minimum = kind === 'workerConnections' ? 128 : 1, maximum = kind === 'workerConnections' ? 32768 : 1000000;
    if (typeof raw !== 'string' || !/^[1-9][0-9]{0,6}$/.test(raw) || Number(raw) < minimum || Number(raw) > maximum) throw new TypeError(name + ' must be ' + minimum + '..' + maximum);
    return [kind, Number(raw)];
  }));
}
function render(template, { replicas = 1, source = process.env } = {}) {
  const selected = policy(source);
  const marker = '  upstream api { zone upstream_api 64k; server api:1337 resolve; }';
  const location = '    location ^~ /socket.io/ {';
  if (!template.includes(marker) || !template.includes(location) || !template.includes('events { worker_connections 1024; }')) throw new TypeError('Unexpected Compose edge template');
  const rules = [
    '  map $arg_sid $handshake_client { "" $binary_remote_addr; default ""; }',
    '  limit_conn_zone $binary_remote_addr zone=socket_connections:10m;',
    '  limit_req_zone $handshake_client zone=socket_handshakes:10m rate=' + selected.rate + 'r/s;',
    '  limit_conn_status 429;',
    '  limit_req_status 429;'
  ].join('\n');
  return template.replace('events { worker_connections 1024; }', 'worker_rlimit_nofile 65536;\nevents { worker_connections ' + selected.workerConnections + '; }').replace(marker, rules + '\n' + (replicas > 1 ? marker.replace('server api:', 'server api-internal:') : marker))
    .replace(location, location + '\n      limit_conn socket_connections ' + selected.connections + ';\n      limit_req zone=socket_handshakes burst=' + selected.burst + ' nodelay;');
}
module.exports = { DEFAULTS, policy, render };
