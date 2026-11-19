'use strict';

// Prospective Compose planner. Serving-role admission and producer bindings are
// supplied by the selected application revision before this plan can be used.
const { bucket, RULE } = require('../../lib/pool-membership/slice');
const replicas = require('./replicas');
const MAP = 'NS_REALTIME_STATIC_ROUTE_MAP';
const PROFILE = 'static-ownership-plan';
const MAX_WORKERS = 8;

function count(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WORKERS) throw new TypeError('STATIC_OWNERSHIP_COUNT');
  return value;
}

function workers(role, k, port) {
  return Array.from({length: k}, (_, ordinal) => {
    const service = ordinal === 0 ? role : role + '-' + (ordinal + 1);
    const id = role + '-' + (ordinal + 1);
    return { count: k, ordinal, service, id, socketPath: '/run/ns-ipc/' + id + '.sock',
      origin: 'http://' + service + ':' + port + '/' };
  });
}

function plan(k, apiReplicas) {
  count(k);
  const n = replicas.count({ NS_API_REPLICAS: String(apiReplicas) });
  const realtime = workers('realtime', k, 1339), evaluator = workers('evaluator', k, 19913);
  const peers = JSON.stringify(realtime.map(worker => ({socket: worker.socketPath})));
  const applicationEnvironment = Object.fromEntries([
    ...realtime.map(worker => [worker.service, {NS_REALTIME_SLICE: JSON.stringify({count: k, ordinal: worker.ordinal})}]),
    ...evaluator.map(worker => [worker.service, {NS_REALTIME_SLICE_PEERS: peers}])
  ]);
  return { count: k, rule: RULE, evaluator, realtime, api: replicas.instances(n), applicationEnvironment,
    routes: { version: 1, rule: RULE, count: k, upstreams: realtime.map(worker => worker.origin) } };
}

function compile(value, expectedCount) {
  if (!value || Object.keys(value).sort().join(',') !== 'count,rule,upstreams,version' ||
      value.version !== 1 || value.rule !== RULE || value.count !== count(expectedCount) ||
      !Array.isArray(value.upstreams) || value.upstreams.length !== expectedCount ||
      new Set(value.upstreams).size !== expectedCount) throw new TypeError('STATIC_REALTIME_ROUTE_MAP');
  const upstreams = value.upstreams.map(origin => {
    if (typeof origin !== 'string') throw new TypeError('STATIC_REALTIME_ROUTE_MAP');
    const url = new URL(origin);
    if (url.href !== origin || url.protocol !== 'http:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash || Number(url.port) < 1024) throw new TypeError('STATIC_REALTIME_ROUTE_MAP');
    return origin;
  });
  return Object.freeze({
    route(tenant) { return { consumerOrigin: upstreams[bucket(tenant, expectedCount)] }; }
  });
}

function load(source) {
  const raw = source[MAP];
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2048 ||
      !/^[1-8]$/.test(source.NS_REALTIME_STATIC_COUNT || '')) throw new TypeError('STATIC_REALTIME_ROUTE_MAP');
  const k = Number(source.NS_REALTIME_STATIC_COUNT), value = JSON.parse(raw);
  const expected = plan(k, 1).routes.upstreams;
  if (JSON.stringify(value?.upstreams) !== JSON.stringify(expected)) throw new TypeError('STATIC_REALTIME_UPSTREAM_ROSTER');
  return compile(value, k);
}

function validateCompose(config, selected) {
  const services = config.services;
  const expected = [...selected.evaluator, ...selected.realtime];
  const actual = Object.keys(services).filter(name => /^(?:evaluator|realtime)(?:-\d+)?$/.test(name));
  if (actual.length !== expected.length) throw new TypeError('STATIC_OWNERSHIP_WORKER_ROSTER');
  for (const worker of expected) {
    const labels = services[worker.service]?.labels;
    if (!labels) throw new TypeError('STATIC_OWNERSHIP_WORKER_ROSTER');
    if (labels['org.nightscout.static-ownership.ordinal'] !== String(worker.ordinal) ||
        labels['org.nightscout.static-ownership.count'] !== String(selected.count)) {
      throw new TypeError('STATIC_OWNERSHIP_WORKER_MISMATCH');
    }
  }
  const edge = services['socket-edge']?.environment;
  if (edge?.NS_REALTIME_STATIC_COUNT !== String(selected.count)) throw new TypeError('STATIC_REALTIME_COUNT_MISMATCH');
  load(edge);
}

function render(k, n, composeFile, nginxTemplate) {
  const selected = plan(k, n);
  const lines = ['# Prospective shape. Requires selected native evaluator and realtime contracts.', 'services:'];
  for (const [role, instances] of Object.entries({evaluator: selected.evaluator, realtime: selected.realtime})) {
    for (const worker of instances) {
      lines.push('  ' + worker.service + ':', '    profiles: [' + PROFILE + ']');
      if (worker.ordinal !== 0) lines.push(
        '    extends: {file: ' + JSON.stringify(composeFile) + ', service: ' + role + '}',
        '    volumes:',
        '      - ${NS_DEMO_STATE}/' + worker.service + ':/run/ns-config:ro',
        '      - ${NS_DEMO_STATE}/ipc:/run/ns-ipc',
        '      - ${NS_DEMO_STATE}/tls/ca.crt:/run/ns-ca/ca.crt:ro'
      );
      lines.push('    labels:',
        '      org.nightscout.static-ownership.ordinal: "' + worker.ordinal + '"',
        '      org.nightscout.static-ownership.count: "' + worker.count + '"');
    }
  }
  lines.push('  pgstream:', '    profiles: [' + PROFILE + ']', '    depends_on:',
    ...selected.evaluator.map(worker => '      ' + worker.service + ': {condition: service_started}'),
    '  socket-edge:', '    profiles: [' + PROFILE + ']',
    '    extends: {file: ' + JSON.stringify(composeFile) + ', service: ui}',
    '    command: [node, -r, ./deploy/multitenant/load-env.js, deploy/multitenant/socket-edge.js]',
    '    environment:', '      NS_REALTIME_STATIC_COUNT: "' + k + '"',
    '      ' + MAP + ': ' + JSON.stringify(JSON.stringify(selected.routes)),
    '    healthcheck:',
    '      test: [CMD, node, -e, "fetch(\'http://127.0.0.1:1343/healthz\').then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})"]',
    '  nginx:', '    profiles: [' + PROFILE + ']', '    depends_on: !override',
    '      socket-edge: {condition: service_healthy}', '      ui: {condition: service_healthy}',
    ...selected.api.map(worker => '      ' + worker.service + ': {condition: service_healthy}'));
  return { selected, compose: lines.join('\n') + '\n', api: replicas.compose(selected.api.length, composeFile),
    nginx: require('./edge').render(nginxTemplate, {replicas: selected.api.length, realtime: true}) };
}

module.exports = { MAP, PROFILE, plan, compile, load, validateCompose, render };
