'use strict';

// Private streaming edge for the selected fixed realtime placement. Destination
// addresses come exclusively from operator configuration after canonical Host
// resolution. Backend admission independently checks current ownership/readiness.
//
// Upstream connections (2026-11-24). A destination is resolved once and the address is kept
// for resolveTtlMs (served stale while one refresh runs), and dropped at once when a connect to
// it fails, so a restarted Pod's new address is used on the next request. A per-request
// dns.lookup queued on libuv's 4-thread pool under ndots:5 until the connect timer answered 503
// while realtime was idle (kind c2-06). Plain requests share a keep-alive http.Agent per
// destination (at most maxConnections sockets, keepAliveSockets idle, idle sockets closed after
// idleMs, below the realtime server's 5 s keepAliveTimeout); an upgrade needs its own socket and
// uses no agent. The connect timer starts when a socket starts connecting: it covers the TCP
// (and TLS) connect only, never resolution or a reused socket. Hop-by-hop headers of plain
// requests are not forwarded, so a client's Connection: close does not close the upstream.
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade'];
function withoutHop(headers) {
  const named = String(headers.connection || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
  const out = {};
  for (const key of Object.keys(headers)) if (!HOP.includes(key) && !named.includes(key)) out[key] = headers[key];
  return out;
}
function create({ resolver, placement, timeoutMs = 60000, connectTimeoutMs = 5000, maxConnections = 65536,
  keepAliveSockets = 256, idleMs = 4000, resolveTtlMs = 5000 }) {
  if (typeof resolver?.resolveTenant !== 'function' || typeof placement?.route !== 'function') throw new TypeError('Explicit registry and placement required');
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 100000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
      !Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > timeoutMs ||
      !Number.isSafeInteger(keepAliveSockets) || keepAliveSockets < 0 || keepAliveSockets > maxConnections ||
      !Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > 60000 || !Number.isSafeInteger(resolveTtlMs) || resolveTtlMs < 1 || resolveTtlMs > 300000) throw new TypeError('Explicit bounded socket edge limits required');
  const active = new Set();
  const destinations = new Map();
  let closing = false;
  const refused = (target, status) => {
    if (target.writeHead) { if (!target.headersSent) target.writeHead(status); target.end(); }
    else { target.end('HTTP/1.1 ' + status + ' Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
  };
  function destinationOf(url) {
    let entry = destinations.get(url.origin);
    if (!entry) {
      const transport = url.protocol === 'https:' ? https : http;
      entry = { url, transport, resolving: null, address: null, expires: 0,
        agent: new transport.Agent({ keepAlive: true, maxSockets: maxConnections, maxFreeSockets: keepAliveSockets, timeout: idleMs, scheduling: 'lifo' }) };
      destinations.set(url.origin, entry);
    }
    return entry;
  }
  // One lookup per destination at a time; every waiting request shares it.
  function refresh(entry) {
    if (!entry.resolving) {
      const hostname = entry.url.hostname.replace(/^\[|\]$/g, '');
      const resolving = net.isIP(hostname) ? Promise.resolve(hostname) : new Promise((resolve, reject) =>
        dns.lookup(hostname, {}, (error, address) => error ? reject(error) : resolve(address)));
      entry.resolving = resolving;
      resolving.then(address => { entry.address = address; entry.expires = Date.now() + resolveTtlMs; },
        () => {}).finally(() => { if (entry.resolving === resolving) entry.resolving = null; });
    }
    return entry.resolving;
  }
  function address(entry) {
    if (entry.address === null) return refresh(entry);
    if (Date.now() >= entry.expires) refresh(entry).catch(() => {});
    return Promise.resolve(entry.address);
  }
  function forget(entry, used) { if (entry.address === used) { entry.address = null; entry.expires = 0; } }
  function deadline(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('SOCKET_EDGE_RESOLVE_TIMEOUT')), ms); timer.unref?.(); })])
      .finally(() => clearTimeout(timer));
  }
  async function forward(req, target, head) {
    let upstream;
    try {
      if (closing || active.size >= maxConnections) return refused(target, 503);
      if (!/^\/socket\.io\/(?:\?|$)/.test(req.url) || !['GET','POST','OPTIONS'].includes(req.method)) return refused(target, 404);
      const tenant = await resolver.resolveTenant(req);
      if (target.destroyed || closing) return;
      if (active.size >= maxConnections) return refused(target, 503);
      const entry = destinationOf(new URL(placement.route(tenant).consumerOrigin));
      const destination = entry.url;
      const used = await deadline(address(entry), timeoutMs);
      if (target.destroyed || closing) return;
      if (active.size >= maxConnections) return refused(target, 503);
      upstream = entry.transport.request({ protocol: destination.protocol, hostname: used, port: destination.port || undefined,
        servername: net.isIP(destination.hostname) ? undefined : destination.hostname, method: req.method, path: req.url,
        headers: head === undefined ? withoutHop(req.headers) : req.headers, agent: head === undefined ? entry.agent : false });
      active.add(upstream);
      let connecting;
      let connected = false;
      upstream.once('socket', socket => {
        if (!socket.connecting) { connected = true; return; }
        connecting = setTimeout(() => upstream.destroy(), connectTimeoutMs); connecting.unref?.();
        socket.once(destination.protocol === 'https:' ? 'secureConnect' : 'connect', () => { connected = true; clearTimeout(connecting); });
      });
      const timer = setTimeout(() => upstream.destroy(), timeoutMs); timer.unref?.();
      const ready = () => { clearTimeout(timer); clearTimeout(connecting); };
      upstream.once('close', () => { ready(); active.delete(upstream); });
      upstream.once('error', () => {
        ready(); if (!connected) forget(entry, used);
        if (target.headersSent) target.destroy(); else refused(target, 503);
      });
      req.once('aborted', () => upstream.destroy());
      target.once('close', () => upstream.destroy());
      target.once('error', () => upstream.destroy());
      upstream.once('response', response => {
        ready();
        if (head !== undefined) { response.destroy(); refused(target, 503); return; }
        response.once('error', () => target.destroy());
        response.once('aborted', () => target.destroy());
        target.writeHead(response.statusCode, withoutHop(response.headers)); response.pipe(target);
      });
      upstream.once('upgrade', (response, socket, upstreamHead) => {
        ready();
        if (head === undefined || response.statusCode !== 101) { socket.destroy(); refused(target, 503); return; }
        active.delete(upstream); active.add(socket);
        socket.once('error', () => target.destroy());
        socket.once('close', () => { active.delete(socket); target.destroy(); });
        target.once('close', () => socket.destroy());
        const lines = ['HTTP/1.1 101 Switching Protocols'];
        for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(response.rawHeaders[i] + ': ' + response.rawHeaders[i + 1]);
        target.write(lines.join('\r\n') + '\r\n\r\n');
        if (upstreamHead.length) target.write(upstreamHead);
        if (head.length) socket.write(head);
        target.pipe(socket); socket.pipe(target);
      });
      req.pipe(upstream);
    } catch (error) {
      upstream?.destroy();
      refused(target, /^TENANT_(HOST_|HEADERS_|SELECTOR_|PROXY_|ORIGIN_)/.test(error?.code || '') ? 421 : 503);
    }
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz' && req.method === 'GET') { res.end('ok\n'); return; }
    void forward(req, res);
  });
  server.on('upgrade', (req, socket, head) => { void forward(req, socket, head); });
  server.on('clientError', (error, socket) => socket.destroy());
  return Object.freeze({ server, async close() {
    closing = true;
    const stopped = new Promise(resolve => server.close(resolve));
    for (const item of active) item.destroy();
    for (const entry of destinations.values()) entry.agent.destroy();
    server.closeAllConnections();
    await stopped; await resolver.close();
  } });
}
function loadPlacement(source) {
  const internal = require('../../lib/server/internal-api/listener-config').observer(source);
  if (!source.MULTITENANT_REALTIME_ROUTES) throw new Error('Explicit admitted routing view required');
  return require('../../lib/realtime-placement').load({ ...source, MULTITENANT_REALTIME_PLACEMENT: source.MULTITENANT_REALTIME_ROUTES }, { internal });
}
async function main(source = process.env) {
  const fs = require('node:fs');
  const config = JSON.parse(fs.readFileSync(source.UI_PUBLIC_CONFIG, 'utf8'));
  const staticOwnership = require('./static-ownership');
  const fixed = source[staticOwnership.MAP] !== undefined || source.NS_REALTIME_STATIC_COUNT !== undefined;
  if (fixed && source.MULTITENANT_REALTIME_ROUTES !== undefined) throw new TypeError('REALTIME_ROUTE_PROFILE_CONFLICT');
  const staticPlacement = fixed ? staticOwnership.load(source) : null;
  const resolver = await require('./ui-registry').open({ config, source });
  try {
    const placement = staticPlacement || loadPlacement(source);
    const edge = create({ resolver, placement });
    edge.server.once('error', () => { void edge.close().catch(() => {}); process.exitCode = 1; });
    edge.server.listen(1343, '0.0.0.0');
    let closing;
    for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => { closing ||= edge.close().catch(() => { process.exitCode = 1; }); });
  } catch (error) { await resolver.close(); throw error; }
}
if (require.main === module) main().catch(() => { process.stderr.write('Socket edge unavailable\n'); process.exitCode = 1; });
module.exports = { create, main };
