#!/usr/bin/env node
'use strict';

// Source-only deployment boundary check. `compose config` does not contact the
// daemon or create a service. Never print its expanded environment or secrets.
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
function checkNetworks (config) {
  assert.deepEqual(Object.keys(config.networks).sort(), ['backend', 'edge'], 'Only backend and ingress edge networks are admitted');
  assert(config.networks.backend.internal === true, 'Backend network must be internal');
  assert(config.networks.edge.internal !== true && config.networks.edge.driver === 'bridge', 'Ingress edge must be an ordinary bridge');
  for (const [name, service] of Object.entries(config.services)) {
    const networks = Array.isArray(service.networks) ? [...service.networks] : Object.keys(service.networks || {});
    assert.deepEqual(networks.sort(), name === 'nginx' ? ['backend', 'edge'] : ['backend'],
      name === 'nginx' ? 'nginx requires backend and ingress edge' : name + ' must remain on backend only');
    if (name !== 'nginx') assert(!(service.ports || []).length, name + ' publishes a private listener');
  }
  return true;
}
// Start order: each runtime role waits for its dependencies' healthchecks. The edge waits only for
// the roles it routes to; evaluator or tenant-admin health must never gate access to the site.
const ORDER = {api: ['postgres', 'vault'], realtime: ['api'], evaluator: ['realtime'], 'tenant-admin': ['api'],
  nginx: ['api', 'realtime', 'ui']};
const EDGE_INDEPENDENT = ['evaluator', 'tenant-admin'];
function checkOrder (config) {
  for (const [name, needs] of Object.entries(ORDER)) {
    const depends = config.services[name].depends_on || {};
    for (const need of needs) {
      assert(depends[need]?.condition === 'service_healthy', name + ' must wait for ' + need + ' to be healthy');
      assert(config.services[need].healthcheck?.test, need + ' needs a healthcheck to be waited on');
    }
  }
  for (const [name, service] of Object.entries(config.services)) {
    if (!/^api-\d+$/.test(name)) continue;
    for (const need of ['postgres', 'vault']) assert(service.depends_on?.[need]?.condition === 'service_healthy', name + ' must wait for ' + need);
    assert(config.services.nginx.depends_on?.[name]?.condition === 'service_healthy', 'nginx must wait for every API instance');
  }
  for (const name of EDGE_INDEPENDENT) assert(!Object.hasOwn(config.services.nginx.depends_on || {}, name), 'nginx must not wait for ' + name);
  return true;
}
// The edge re-resolves upstream names (a restarted role may come back on a new address).
function checkEdgeResolve (text) {
  assert(/^\s*resolver\s+127\.0\.0\.11\b[^;]*valid=\d+s/m.test(text), 'nginx must use Docker DNS with a bounded validity');
  const servers = [...text.matchAll(/^\s*upstream\s+(\S+)\s*\{([^}]*)\}/gm)];
  assert(servers.length >= 3, 'nginx upstreams missing');
  for (const [, name, body] of servers) {
    assert(/\bzone\s+\S+\s+\d+k;/.test(body) && /\bserver\s+\S+\s+resolve;/.test(body), 'nginx upstream ' + name + ' must re-resolve (zone + resolve)');
  }
  return true;
}
// nginx.compose.conf is nginx.conf (which the Kubernetes binding imports byte for byte, and whose
// Service names need no re-resolution) plus the re-resolution lines and nothing else.
function sharedEdge (composeText) {
  return composeText.split('\n').filter(line => !/^\s*(resolver|resolver_timeout)\s/.test(line) && !/^# (Compose edge|of the upstream|apart from)/.test(line) &&
    !/^\s*# (Upstream names are re-resolved|container that restarts|the edge \(nginx|Without it nginx resolves)/.test(line)).join('\n')
    .replace(/\{ zone \S+ \d+k; (server \S+) resolve; \}/g, '{ $1; }');
}
function checkEdgeSame (sharedText, composeText) {
  assert(sharedEdge(composeText) === sharedText, 'nginx.compose.conf must equal nginx.conf apart from upstream re-resolution');
  return true;
}
function checkPublisher(config) {
  const service=config.services['placement-operator'];
  assert(service && service.profiles?.includes('ops'), 'Placement publisher must be explicit');
  assert(!Object.keys(service.environment || {}).some(key=>/PG|PASSWORD|TOKEN|VAULT|NS_ENV_FILE/.test(key)), 'Publisher credential values belong only in its scoped private document');
  const volumes=service.volumes || [];
  assert(volumes.length===2 && volumes.some(row=>row.target==='/run/ns-config' && row.source.endsWith('/placement-operator') && row.read_only) && volumes.some(row=>row.target==='/run/ns-placement' && row.source.endsWith('/placement') && !row.read_only), 'Publisher mounts only its readonly authority and writable placement');
  assert(!(service.ports||[]).length && !service.privileged && service.network_mode!=='host', 'Publisher has no public listener or privileged runtime');
  return true;
}
function checkStream(config) {
  const service=config.services.pgstream,evaluator=config.services.evaluator;
  assert(service,'Separate pgstream service required');
  assert.deepEqual(service.command,['/usr/local/bin/pgstream','run','-c','/run/ns-stream/pgstream.yaml','--log-level','info'],'pgstream must run the maintained binary directly');
  assert(service.restart==='unless-stopped','Platform must own streaming restart');
  assert(service.depends_on?.postgres?.condition==='service_healthy','pgstream waits for PostgreSQL');
  assert(service.depends_on?.evaluator?.condition==='service_started','pgstream must not wait for clinical readiness');
  assert(!Object.hasOwn(evaluator.depends_on||{},'pgstream'),'Evaluator startup must not depend on stream health');
  const volumes=service.volumes||[];
  assert(volumes.length===1&&volumes[0].target==='/run/ns-stream'&&volumes[0].source.endsWith('/pgstream')&&volumes[0].read_only,'Streaming credentials belong only to the separate service');
  assert(!(evaluator.volumes||[]).some(row=>row.target==='/run/ns-stream'||row.source.endsWith('/pgstream')),'Evaluator must not mount streaming credentials');
  assert(!Object.keys(evaluator.environment||{}).some(key=>['NS_PGSTREAM_BINARY','NS_PGSTREAM_CONFIG'].includes(key)),'Evaluator has no stream process configuration');
  return true;
}
// PostgreSQL keeps reserved_connections slots for the clinical roles bootstrap
// grants pg_use_reserved_connections (clinical-isolation.js).
function checkClinicalReserve (config) {
  const command = config.services.postgres.command || [];
  const value = name => { const row = command.find(item => typeof item === 'string' && item.startsWith(name + '=')); return row ? Number(row.slice(name.length + 1)) : NaN; };
  const max = value('max_connections'), reserved = value('reserved_connections');
  assert(Number.isSafeInteger(reserved) && reserved >= 1, 'PostgreSQL must reserve connection slots for clinical roles');
  assert(Number.isSafeInteger(max) && max - require('./clinical-isolation').SUPERUSER_RESERVED - reserved >= 1, 'PostgreSQL reserved_connections must leave general slots');
  return true;
}
function check (config) {
  checkNetworks(config);
  checkClinicalReserve(config);
  checkPublisher(config);
  checkStream(config);
  const runtime = ['pgstream', 'api', 'realtime', 'evaluator', 'tenant-admin', 'ui', 'nginx', 'admin', ...Object.keys(config.services).filter(name => /^api-\d+$/.test(name))];
  for (const name of runtime) {
    const service = config.services[name];
    assert(service, 'Missing service: ' + name);
    for (const volume of service.volumes || []) {
      assert(!/\/(bootstrap|ops|tls)\/?$/.test(volume.source), name + ' mounts a privileged directory');
      if (volume.target === '/run/ns-config') {
        assert(volume.source.endsWith('/' + name) && volume.read_only, name + ' must mount only its own read-only config');
      }
      assert(!['/var/run/docker.sock', '/run/docker.sock', '/state'].includes(volume.target), name + ' mounts a privileged endpoint');
    }
    assert(!service.privileged && service.network_mode !== 'host', name + ' changes the isolation boundary');
  }
  for (const name of ['ui', 'nginx']) {
    const service = config.services[name];
    assert(!(service.volumes || []).some(v => v.target === '/run/ns-ipc'), name + ' must not mount private IPC');
    assert(!Object.keys(service.environment || {}).some(k => /TOKEN|PASSWORD|PG|DATABASE/.test(k)), name + ' receives private credentials');
  }
  assert(config.services.primer.profiles.includes('ops'), 'Lab priming must remain explicit');
  assert(!Object.keys(config.services.primer.environment || {}).some(name => /PG|PASSWORD|TOKEN|VAULT/.test(name)), 'Lab primer must not receive database or Vault credentials');
  assert(config.services.bootstrap.profiles.includes('ops'), 'Bootstrap must remain explicit');
  assert(config.services.demo.profiles.includes('ops'), 'Restore demonstration must remain explicit');
  checkOrder(config);
  const ports = config.services.nginx.ports;
  assert(ports.length === 1 && ['127.0.0.1', '169.254.1.1'].includes(ports[0].host_ip), 'Demo ingress must bind the selected local address');
  return true;
}
if (require.main === module) {
  try {
    const bytes = execFileSync('docker', ['compose', '--profile', '*', '-f', 'compose.yaml', 'config', '--format', 'json'], {
      cwd: __dirname, encoding: 'utf8', env: {...process.env,
        NS_DEMO_STATE: process.env.NS_DEMO_STATE || '/tmp/ns-compose-source-check',
        NS_SOURCE_COMMIT: process.env.NS_SOURCE_COMMIT || '0'.repeat(40), NS_DEPLOY_COMMIT: process.env.NS_DEPLOY_COMMIT || '0'.repeat(40)}
    });
    const config = JSON.parse(bytes); check(config);
    const unreserved = structuredClone(config);
    unreserved.services.postgres.command = unreserved.services.postgres.command.filter(item => !String(item).startsWith('reserved_connections='));
    assert.throws(() => check(unreserved), /reserve connection slots for clinical roles/, 'Clinical connection reserve control must fail');
    const broken = structuredClone(config);
    broken.services.ui.volumes.push({type: 'bind', source: '/tmp/state/ops', target: '/state'});
    assert.throws(() => check(broken), /privileged directory/, 'Credential-exposure control must fail');
    const exposed = structuredClone(config);
    exposed.services['tenant-admin'].ports = [{target: 1341, published: '1341', host_ip: '0.0.0.0'}];
    assert.throws(() => check(exposed), /publishes a private listener/, 'Management-exposure control must fail');
    const disconnected = structuredClone(config);
    delete disconnected.services.nginx.networks.edge;
    assert.throws(() => check(disconnected), /nginx requires backend and ingress edge/, 'Internal-only ingress control must fail');
    const edgeExposure = structuredClone(config);
    edgeExposure.services.api.networks.edge = null;
    assert.throws(() => check(edgeExposure), /api must remain on backend only/, 'Private-service edge control must fail');
    const unordered = structuredClone(config);
    delete unordered.services.nginx.depends_on.realtime;
    assert.throws(() => check(unordered), /nginx must wait for realtime/, 'Start-order control must fail');
    const gated = structuredClone(config);
    gated.services.nginx.depends_on.evaluator = {condition: 'service_healthy', required: true, restart: false};
    assert.throws(() => check(gated), /nginx must not wait for evaluator/, 'Edge-gating control must fail');
    const read = name => require('node:fs').readFileSync(require('node:path').join(__dirname, name), 'utf8');
    const nginx = read('nginx.compose.conf'), shared = read('nginx.conf');
    assert(config.services.nginx.volumes.some(v => v.target === '/etc/nginx/nginx.conf' && v.source.endsWith('/edge/nginx.conf') && v.read_only), 'Compose edge must mount only its prepared read-only edge configuration');
    checkEdgeResolve(nginx); checkEdgeSame(shared, nginx);
    assert.throws(() => checkEdgeResolve(nginx.replace('server api:1337 resolve;', 'server api:1337;')), /upstream api must re-resolve/, 'Edge re-resolve control must fail');
    assert.throws(() => checkEdgeSame(shared, nginx.replace("proxy_set_header Cookie '';", '')), /must equal nginx.conf/, 'Edge drift control must fail');
    check(config);
    process.stdout.write('Compose boundaries, start order, edge re-resolution and edge equivalence pass; credential, private-listener, ingress-network, start-order, edge-gating, re-resolve, edge-drift and clinical-reserve controls rejected; restored configuration passes. Runtime UNMEASURED.\n');
  } catch (error) {
    // Authored assertion messages name only a service/property, never values.
    process.stderr.write('Compose boundary check failed: ' + (error.code === 'ERR_ASSERTION' ? error.message : error.code || 'configuration expansion') + '\n'); process.exitCode = 1;
  }
}
module.exports = {checkStream, check, checkClinicalReserve, checkPublisher, checkNetworks, checkOrder, checkEdgeResolve, checkEdgeSame};
