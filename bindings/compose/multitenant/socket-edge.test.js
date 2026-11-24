'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { create } = require('./socket-edge');
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; }
function get(origin, host, path = '/socket.io/?EIO=4&transport=polling', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(origin + path, { headers: { host, ...headers }, agent: false }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }); req.on('error', reject);
  });
}
test('canonical tenant routing follows current map; selectors and unknown hosts never reach a backend', async () => {
  const ui = require('./ui-registry');
  const core = process.env.NS_UI_TEST_CORE;
  assert.ok(core, 'NS_UI_TEST_CORE must name the joined source');
  const resolverFactory = require(core + '/lib/tenant-registry/resolver').createRegistryResolver;
  const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
  let calls = 0;
  const servers = ['one','two'].map(label => http.createServer((req, res) => { calls++; res.end(label + ':' + req.headers.host); }));
  const origins = await Promise.all(servers.map(listen));
  const reader = ui.create({ settings: { maxTenants: 2, refreshMs: 250, maxInflight: 8, theme: 'default' },
    store: { revision: async () => '1', entry: async () => { throw new Error('No tenant attributes'); }, lookup: async (host, kind) => kind === 'alias' && ({ 'one.example.test': a, 'two.example.test': b })[host] ? { tenant: ({ 'one.example.test': a, 'two.example.test': b })[host], state: 'active' } : null }, resolverFactory });
  await reader.start();
  const routes = new Map([[a, origins[0]], [b, origins[1]]]);
  const edge = create({ resolver: reader, placement: { route: tenant => ({ consumerOrigin: routes.get(tenant) }) } });
  const origin = await listen(edge.server);
  try {
    assert.deepEqual(await get(origin, 'one.example.test'), { status: 200, body: 'one:one.example.test' });
    assert.equal((await get(origin, 'two.example.test')).body, 'two:two.example.test');
    const before = calls;
    for (const [host, headers] of [['unknown.example.test', {}], ['one.example.test', { 'x-resolved-tenant': b }], ['one.example.test', { 'x-forwarded-host': 'two.example.test' }]]) assert.equal((await get(origin, host, undefined, headers)).status, 421);
    assert.equal(calls, before);
    routes.set(a, origins[1]);
    assert.equal((await get(origin, 'one.example.test')).body, 'two:one.example.test');
    assert.equal((await get(origin, 'two.example.test')).body, 'two:two.example.test');
  } finally { await edge.close(); await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
});
test('upgrade streams both heads and socket bytes and closes the owned transport', async () => {
  const backend = http.createServer();
  const sockets = new Set();
  backend.on('upgrade', (req, socket, head) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nbackend-head');
    if (head.length) socket.write(head);
    socket.on('data', chunk => socket.write(chunk));
  });
  const destination = await listen(backend);
  const edge = create({ resolver: { resolveTenant: async () => 'tenant', close: async () => {} }, placement: { route: () => ({ consumerOrigin: destination }) } });
  const origin = new URL(await listen(edge.server));
  const socket = net.connect(Number(origin.port), '127.0.0.1');
  await once(socket, 'connect');
  try {
    let received = '';
    const echoed = new Promise((resolve, reject) => {
      socket.on('data', bytes => { received += bytes; if (received.includes('backend-head') && received.includes('client-head')) resolve(); });
      socket.on('error', reject);
    });
    socket.write('GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: one.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nclient-head');
    await Promise.race([echoed, new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('UPGRADE_TIMEOUT')), 2000); timer.unref(); })]);
    assert.match(received, /^HTTP\/1.1 101/);
  } finally { socket.destroy(); await edge.close(); for (const connection of sockets) connection.destroy(); await new Promise(resolve => backend.close(resolve)); }
});
test('unavailable destination refuses within a bounded header deadline', async () => {
  const backend = http.createServer(() => {}), destination = await listen(backend);
  const edge = create({ resolver: { resolveTenant: async () => 'tenant', close: async () => {} }, placement: { route: () => ({ consumerOrigin: destination }) }, timeoutMs: 20, connectTimeoutMs: 10 });
  const origin = await listen(edge.server);
  try { assert.equal((await get(origin, 'one.example.test')).status, 503); assert.equal((await get(origin, 'one.example.test', '/api/v3/entries')).status, 404); }
  finally { await edge.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
});
test('stock long polling remains connected while its next response waits beyond five seconds', { timeout: 15000 }, async () => {
  const core = process.env.NS_UI_TEST_CORE; assert.ok(core, 'Explicit joined source dependencies required');
  const { Server } = require(core + '/node_modules/socket.io');
  const { io } = require(core + '/node_modules/socket.io-client');
  const backend = http.createServer(), sockets = new Server(backend, { serveClient: false, transports: ['polling'], pingInterval: 10000, pingTimeout: 5000 });
  const destination = await listen(backend);
  const edge = create({ resolver: { resolveTenant: async () => 'tenant', close: async () => {} }, placement: { route: () => ({ consumerOrigin: destination }) } });
  const origin = new URL(await listen(edge.server));
  const agent = new http.Agent({ lookup: (host, options, done) => options?.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4) });
  const client = io('http://one.example.test:' + origin.port, { transports: ['polling'], upgrade: false, reconnection: false, agent, autoConnect: false });
  const disconnected = [];
  client.on('disconnect', reason => disconnected.push(reason));
  try {
    const connected = new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); }); client.connect(); await connected;
    await new Promise(resolve => setTimeout(resolve, 6200));
    assert.equal(client.connected, true); assert.deepEqual(disconnected, []);
  } finally { client.disconnect(); agent.destroy(); await edge.close(); await new Promise(resolve => sockets.close(resolve)); }
});
// Upstream connections (lane E, 2026-11-24). On Kubernetes each route-map upstream is a Pod DNS name
// (realtime-<i>.realtime-peers.<ns>.svc) and dns.lookup runs on libuv's 4-thread pool, walking the
// ndots:5 search list. A per-request lookup queues under a priming burst until the connect timer
// answers 503 while realtime is idle (lane L viewer-path diagnostic, kind c2-06). The slow resolver
// below models that pool: four workers, a fixed latency per lookup, names under .svc only.
function slowResolver({ workers = 4, latencyMs = 150, addresses }) {
  const dns = require('node:dns');
  const original = dns.lookup;
  const queue = [];
  let busy = 0;
  const stats = { lookups: 0 };
  const pump = () => {
    while (busy < workers && queue.length) {
      const [host, options, done] = queue.shift(); busy++;
      setTimeout(() => {
        busy--; pump();
        const address = addresses.get(host);
        if (!address) return done(Object.assign(new Error('getaddrinfo ENOTFOUND ' + host), { code: 'ENOTFOUND' }));
        if (options?.all) done(null, [{ address, family: 4 }]); else done(null, address, 4);
      }, latencyMs);
    }
  };
  dns.lookup = function lookup(host, options, done) {
    if (typeof options === 'function') { done = options; options = {}; }
    if (!/\.svc\.?$/.test(host)) return original.call(dns, host, options, done);
    stats.lookups++; queue.push([host, typeof options === 'number' ? { family: options } : options, done]); pump();
  };
  stats.restore = () => { dns.lookup = original; };
  return stats;
}
function counted(handler) {
  const server = http.createServer(handler);
  server.connections = 0;
  server.on('connection', () => { server.connections++; });
  return server;
}
const fixed = consumerOrigin => ({ resolver: { resolveTenant: async () => 'tenant', close: async () => {} }, placement: { route: () => ({ consumerOrigin }) } });
test('a priming burst through a slow resolver is answered by the owner, not 503, and resolves the destination once', { timeout: 20000 }, async () => {
  const backend = counted((req, res) => res.end('ok'));
  const port = new URL(await listen(backend)).port;
  const name = 'realtime-0.realtime-peers.lanee.svc';
  const resolver = slowResolver({ addresses: new Map([[name, '127.0.0.1']]) });
  const edge = create({ ...fixed('http://' + name + ':' + port + '/'), timeoutMs: 8000, connectTimeoutMs: 1000 });
  const origin = await listen(edge.server);
  try {
    // 120 lookups at 4 x 150 ms take 4.5 s: past the 1 s connect deadline when each request resolves.
    const results = await Promise.all(Array.from({ length: 120 }, (_, i) => get(origin, 'v' + i + '.example.test')));
    const statuses = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
    assert.deepEqual(statuses, { 200: 120 });
    assert.ok(resolver.lookups <= 2, 'destination lookups ' + resolver.lookups);
  } finally { resolver.restore(); await edge.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
});
test('sequential polling requests reuse kept-alive upstream connections, also when the client sends Connection: close', async () => {
  const backend = counted((req, res) => res.end(req.headers.connection || ''));
  const destination = await listen(backend);
  const edge = create(fixed(destination));
  const origin = await listen(edge.server);
  try {
    for (let i = 0; i < 20; i++) assert.equal((await get(origin, 'one.example.test')).status, 200);
    assert.ok(backend.connections <= 2, 'upstream connections ' + backend.connections);
  } finally { await edge.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
});
test('a reused upstream connection is not cut by the connect deadline while a long poll waits', async () => {
  const backend = counted((req, res) => setTimeout(() => res.end('late'), 250));
  const destination = await listen(backend);
  const edge = create({ ...fixed(destination), timeoutMs: 5000, connectTimeoutMs: 100 });
  const origin = await listen(edge.server);
  try {
    for (let i = 0; i < 3; i++) assert.deepEqual(await get(origin, 'one.example.test'), { status: 200, body: 'late' });
  } finally { await edge.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
});
test('a failed connect re-resolves the destination (a restarted Pod has a new address)', { timeout: 10000 }, async () => {
  const backend = counted((req, res) => res.end('ok'));
  const port = new URL(await listen(backend)).port;
  const name = 'realtime-1.realtime-peers.lanee.svc';
  const addresses = new Map([[name, '127.0.0.2']]); // nothing listens there: connection refused
  const resolver = slowResolver({ addresses, latencyMs: 5 });
  const edge = create({ ...fixed('http://' + name + ':' + port + '/'), timeoutMs: 2000, connectTimeoutMs: 1000 });
  const origin = await listen(edge.server);
  try {
    assert.equal((await get(origin, 'one.example.test')).status, 503);
    addresses.set(name, '127.0.0.1');
    assert.equal((await get(origin, 'one.example.test')).status, 200);
    assert.equal((await get(origin, 'one.example.test')).status, 200);
  } finally { resolver.restore(); await edge.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
});
test('websocket upgrades through a named destination use the resolved address', async () => {
  const backend = http.createServer();
  const sockets = new Set();
  backend.on('upgrade', (req, socket) => { sockets.add(socket); socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'); socket.on('data', chunk => socket.write(chunk)); });
  const port = new URL(await listen(backend)).port;
  const name = 'realtime-0.realtime-peers.lanee.svc';
  const resolver = slowResolver({ addresses: new Map([[name, '127.0.0.1']]), latencyMs: 5 });
  const edge = create(fixed('http://' + name + ':' + port + '/'));
  const origin = new URL(await listen(edge.server));
  const clients = [];
  try {
    for (let i = 0; i < 5; i++) {
      const socket = net.connect(Number(origin.port), '127.0.0.1'); clients.push(socket);
      await once(socket, 'connect');
      let received = '';
      const echoed = new Promise(resolve => socket.on('data', bytes => { received += bytes; if (received.includes('ping' + i)) resolve(); }));
      socket.write('GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: one.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nping' + i);
      await echoed;
      assert.match(received, /^HTTP\/1.1 101/);
    }
    assert.ok(resolver.lookups <= 2, 'destination lookups ' + resolver.lookups);
  } finally { resolver.restore(); for (const s of clients) s.destroy(); await edge.close(); for (const s of sockets) s.destroy(); await new Promise(resolve => backend.close(resolve)); }
});
