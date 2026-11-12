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
