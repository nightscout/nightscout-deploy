'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { test } = require('node:test');
const staticOwnership = require('./static-ownership');
const { bucket, RULE } = require('../../lib/pool-membership/slice');
const { create } = require('./socket-edge');

const tenant = index => '11111111-1111-4111-8111-' + String(index).padStart(12, '0');

test('rendered map routes canonical IDs with the exact core slice and rejects the old short hash', () => {
  const modulePath = require.resolve('./static-ownership');
  const original = fs.readFileSync(modulePath, 'utf8');
  const ablation = original.replace('upstreams[bucket(tenant, expectedCount)]',
    "upstreams[require('node:crypto').createHash('sha256').update(tenant).digest().readUInt32BE(0) % expectedCount]");
  assert.notEqual(ablation, original);
  const broken = { exports: {} };
  vm.runInThisContext('(function(require,module){' + ablation + '\n})', {filename: modulePath})(createRequire(modulePath), broken);

  function verify(implementation) {
    for (const k of [1, 2, 3, 7, 8]) {
      const document = implementation.plan(k, 2).routes;
      assert.equal(document.rule, RULE);
      const routing = implementation.load({ [staticOwnership.MAP]: JSON.stringify(document), NS_REALTIME_STATIC_COUNT: String(k) });
      for (let i = 0; i < 256; i++) {
        assert.equal(routing.route(tenant(i)).consumerOrigin, document.upstreams[bucket(tenant(i), k)], 'EDGE_CORE_BUCKET_PARITY');
      }
    }
  }
  verify(staticOwnership);
  assert.throws(() => verify(broken.exports), /EDGE_CORE_BUCKET_PARITY/);
  verify(staticOwnership);
  const good = staticOwnership.plan(2, 1).routes;
  assert.throws(() => staticOwnership.compile(good, 1), /STATIC_REALTIME_ROUTE_MAP/);
  const routes = staticOwnership.compile(good, 2);
  assert.throws(() => routes.route('11111111-1111-4111-A111-111111111111'), /Canonical tenant id/);
  assert.throws(() => staticOwnership.load({NS_REALTIME_STATIC_COUNT:'2',
    [staticOwnership.MAP]:JSON.stringify({...good,upstreams:[...good.upstreams].reverse()})}), /STATIC_REALTIME_UPSTREAM_ROSTER/);
  assert.equal(staticOwnership.load({NS_REALTIME_STATIC_COUNT:'2',[staticOwnership.MAP]:JSON.stringify(good)})
    .route(tenant(0)).consumerOrigin, good.upstreams[bucket(tenant(0), 2)]);
});

test('Compose expansion renders stable K1/K2 owners and N1/N2 upstreams and refuses mixed ordinal/count', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-static-compose-'));
  const base = path.join(__dirname, 'compose.yaml');
  const nginx = fs.readFileSync(path.join(__dirname, 'nginx.compose.conf'), 'utf8');
  try {
    for (const [k, n] of [[1, 1], [2, 1], [2, 2]]) {
      const {selected, compose, api, nginx: renderedNginx} = staticOwnership.render(k, n, base, nginx);
      const workerFile = path.join(workspace, 'workers.yaml'), apiFile = path.join(workspace, 'api.yaml');
      fs.writeFileSync(workerFile, compose);
      fs.writeFileSync(apiFile, api);
      const config = JSON.parse(execFileSync('docker', ['compose', '--project-name', 'ns-static-shape-test',
        '--profile', staticOwnership.PROFILE, '--profile', 'ops', '-f', base, '-f', apiFile, '-f', workerFile, 'config', '--format', 'json'], {
        encoding: 'utf8', timeout: 10000, env: {PATH:process.env.PATH, NS_DEMO_STATE:workspace,
          NS_SOURCE_COMMIT:'a'.repeat(40), NS_DEPLOY_COMMIT:'b'.repeat(40)}
      }));
      const { services } = config;
      staticOwnership.validateCompose(config, selected);
      for (const worker of selected.realtime) {
        assert.deepEqual(JSON.parse(selected.applicationEnvironment[worker.service].NS_REALTIME_SLICE), {count:k,ordinal:worker.ordinal});
      }
      for (const worker of selected.evaluator) {
        assert.deepEqual(JSON.parse(selected.applicationEnvironment[worker.service].NS_REALTIME_SLICE_PEERS),
          selected.realtime.map(peer => ({socket:peer.socketPath})));
      }
      require('./check-compose').checkNetworks(config);
      for (const worker of [...selected.evaluator, ...selected.realtime]) {
        assert.equal(services[worker.service].cpus, undefined);
        assert.equal(services[worker.service].mem_limit, undefined);
        assert(services[worker.service].volumes.some(volume => volume.target === '/run/ns-config' &&
          volume.source.endsWith('/' + worker.service) && volume.read_only === true));
      }
      assert.equal(services.pgstream.cpus, undefined);
      assert.equal(services.pgstream.mem_limit, undefined);
      for (const worker of selected.evaluator) assert.equal(services.pgstream.depends_on[worker.service].condition, 'service_started');
      assert.deepEqual(Object.keys(services.nginx.depends_on).sort(),
        [...selected.api.map(worker => worker.service), 'socket-edge', 'ui'].sort());
      assert.match(renderedNginx, n === 1 ? /server api:1337 resolve/ : /server api-internal:1337 resolve/);
      if (n > 1) for (const worker of selected.api) assert(services[worker.service].networks.backend.aliases.includes('api-internal'));
      assert.match(renderedNginx, /server socket-edge:1343 resolve/);
      const wrongCount = structuredClone(config);
      wrongCount.services['socket-edge'].environment.NS_REALTIME_STATIC_COUNT = k === 1 ? '2' : '1';
      assert.throws(() => staticOwnership.validateCompose(wrongCount, selected), /STATIC_REALTIME_COUNT_MISMATCH/);
      for (const [role, field] of [['evaluator', 'count'], ['realtime', 'ordinal']]) {
        const invalid = structuredClone(config);
        invalid.services[role].labels['org.nightscout.static-ownership.' + field] = k === 1 ? '2' : '1';
        assert.throws(() => staticOwnership.validateCompose(invalid, selected), /STATIC_OWNERSHIP_WORKER_MISMATCH/);
      }
      staticOwnership.validateCompose(config, selected);
    }
    for (const role of ['evaluator','realtime']) {
      const single = staticOwnership.plan(1, 1)[role][0], paired = staticOwnership.plan(2, 2)[role][0];
      assert.deepEqual(single, {...paired, count: 1}, 'ORDINAL_ZERO_STABLE_ACROSS_RESTART_LAYOUTS');
    }
  } finally {
    fs.rmSync(workspace, {recursive:true, force:true});
  }
});

test('socket edge refuses mixed transport profiles and count disagreement before opening the registry', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-static-edge-'));
  try {
    const file = path.join(workspace, 'ui.json');
    fs.writeFileSync(file, '{}');
    const source = {UI_PUBLIC_CONFIG:file, NS_REALTIME_STATIC_COUNT:'2',
      [staticOwnership.MAP]:JSON.stringify(staticOwnership.plan(2,1).routes)};
    const { main } = require('./socket-edge');
    await assert.rejects(main({...source, MULTITENANT_REALTIME_ROUTES:'/unused.json'}), /REALTIME_ROUTE_PROFILE_CONFLICT/);
    await assert.rejects(main({...source, NS_REALTIME_STATIC_COUNT:'1'}), /STATIC_REALTIME_UPSTREAM_ROSTER/);
  } finally {
    fs.rmSync(workspace, {recursive:true, force:true});
  }
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port + '/';
}
function probe(origin, host) {
  return new Promise((resolve, reject) => {
    const request = http.get(new URL('/socket.io/?EIO=4&transport=polling', origin), {
      headers: {host}, agent: false, timeout: 3000
    }, response => { response.resume(); resolve(response.statusCode); });
    request.on('timeout', () => request.destroy());
    request.on('error', reject);
  });
}

test('real Socket.IO polling and upgrade retain the owning slice across registry additions and a dead peer', {timeout: 18000}, async () => {
  const { Server } = require('socket.io'), { io } = require('socket.io-client');
  const roster = [0,1].map(ordinal => {
    const server = http.createServer();
    const sockets = new Server(server, {serveClient:false});
    const seen = {polling:0,websocket:0};
    server.on('request', req => { if (req.url.includes('transport=polling')) seen.polling++; });
    server.on('upgrade', req => { if (req.url.includes('transport=websocket')) seen.websocket++; });
    sockets.on('connection', socket => socket.on('owner', reply => reply(ordinal)));
    return {server,sockets,seen, closed:false};
  });
  const refs = Array.from({length: 40}, (_, index) => tenant(index));
  const initial = [refs.find(id => bucket(id,2) === 0), refs.find(id => bucket(id,2) === 1)];
  const next = refs.find(id => id !== initial[1] && bucket(id,2) === 1);
  assert(next);
  const hosts = new Map([['one.example.test',initial[0]],['two.example.test',initial[1]]]);
  let revision = 1;
  const reader = require('./ui-registry').create({
    settings:{maxTenants:4,refreshMs:250,maxInflight:8,theme:'default'},
    store:{revision:async()=>String(revision),
      entry:async()=>{ throw new Error('The routing fixture only admits host lookup'); },
      lookup:async (host, kind) => kind === 'alias' && hosts.has(host) ? {tenant:hosts.get(host),state:'active'} : null},
    resolverFactory:require('../../lib/tenant-registry/resolver').createRegistryResolver
  });
  let edge, origin;
  const plan = staticOwnership.plan(2, 2);
  const agent = new http.Agent({lookup:(host, options, done) => options?.all
    ? done(null,[{address:'127.0.0.1',family:4}]) : done(null,'127.0.0.1',4)});
  const clients = [];
  async function connect(host, ordinal) {
    const client = io('http://' + host + ':' + new URL(origin).port, {
      transports:['polling','websocket'], agent, timeout:3500, reconnection:false, autoConnect:false
    });
    clients.push(client);
    const connected = new Promise((resolve,reject) => { client.once('connect',resolve); client.once('connect_error',reject); });
    client.connect();
    const upgraded = once(client.io.engine,'upgrade',{signal:AbortSignal.timeout(4500)});
    await Promise.all([connected,upgraded]);
    assert.equal(client.io.engine.transport.name,'websocket');
    assert.equal(await client.timeout(2000).emitWithAck('owner'),ordinal);
  }
  async function closeBackend(row) {
    if (row.closed) return;
    row.closed = true;
    await new Promise(resolve => row.sockets.close(resolve));
  }
  try {
    await reader.start();
    const upstreams = await Promise.all(roster.map(row => listen(row.server)));
    edge = create({resolver:reader, placement:staticOwnership.compile({...plan.routes,upstreams},plan.count)});
    origin = await listen(edge.server);
    await connect('one.example.test',0);
    await connect('two.example.test',1);
    for (const row of roster) assert(row.seen.polling > 0 && row.seen.websocket > 0, 'BOTH_TRANSPORTS_HIT_OWNING_BACKEND');
    assert.equal(await probe(origin,'new.example.test'),421);
    hosts.set('new.example.test',next); revision++;
    await reader.poll();
    await connect('new.example.test',1);
    hosts.delete('new.example.test'); revision++;
    await reader.poll();
    assert.equal(await probe(origin,'new.example.test'),421);
    const before = roster[1].seen.polling;
    await closeBackend(roster[0]);
    assert.equal(await probe(origin,'one.example.test'),503);
    assert.equal(roster[1].seen.polling,before,'UNAVAILABLE_OWNER_MUST_NOT_FALL_THROUGH');
    await connect('two.example.test',1);
  } finally {
    for (const client of clients) client.disconnect();
    agent.destroy();
    if (edge) await edge.close();
    else await reader.close();
    await Promise.all(roster.map(closeBackend));
  }
});
