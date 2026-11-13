'use strict';

// Private streaming edge for the selected fixed realtime placement. Destination
// addresses come exclusively from operator configuration after canonical Host
// resolution. Backend admission independently checks current ownership/readiness.
const http = require('node:http');
const https = require('node:https');
function create({ resolver, placement, timeoutMs = 60000, connectTimeoutMs = 5000, maxConnections = 65536 }) {
  if (typeof resolver?.resolveTenant !== 'function' || typeof placement?.route !== 'function') throw new TypeError('Explicit registry and placement required');
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 100000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
      !Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > timeoutMs) throw new TypeError('Explicit bounded socket edge limits required');
  const active = new Set();
  let closing = false;
  const refused = (target, status) => {
    if (target.writeHead) { if (!target.headersSent) target.writeHead(status); target.end(); }
    else { target.end('HTTP/1.1 ' + status + ' Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
  };
  async function forward(req, target, head) {
    let upstream;
    try {
      if (closing || active.size >= maxConnections) return refused(target, 503);
      if (!/^\/socket\.io\/(?:\?|$)/.test(req.url) || !['GET','POST','OPTIONS'].includes(req.method)) return refused(target, 404);
      const tenant = await resolver.resolveTenant(req);
      if (target.destroyed || closing) return;
      if (active.size >= maxConnections) return refused(target, 503);
      const destination = new URL(placement.route(tenant).consumerOrigin);
      const transport = destination.protocol === 'https:' ? https : http;
      upstream = transport.request(destination, { method: req.method, path: req.url, headers: req.headers, agent: false });
      active.add(upstream);
      const connecting = setTimeout(() => upstream.destroy(), connectTimeoutMs); connecting.unref?.();
      upstream.once('socket', socket => socket.once(destination.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connecting)));
      const timer = setTimeout(() => upstream.destroy(), timeoutMs); timer.unref?.();
      const ready = () => { clearTimeout(timer); clearTimeout(connecting); };
      upstream.once('close', () => { ready(); active.delete(upstream); });
      upstream.once('error', () => { ready(); if (target.headersSent) target.destroy(); else refused(target, 503); });
      req.once('aborted', () => upstream.destroy());
      target.once('close', () => upstream.destroy());
      target.once('error', () => upstream.destroy());
      upstream.once('response', response => {
        ready();
        if (head !== undefined) { response.destroy(); refused(target, 503); return; }
        response.once('error', () => target.destroy());
        response.once('aborted', () => target.destroy());
        target.writeHead(response.statusCode, response.headers); response.pipe(target);
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
    server.closeAllConnections();
    await stopped; await resolver.close();
  } });
}
async function main(source = process.env) {
  const fs = require('node:fs');
  const config = JSON.parse(fs.readFileSync(source.UI_PUBLIC_CONFIG, 'utf8'));
  const resolver = await require('./ui-registry').open({ config, source });
  try {
    const internal = require('../../lib/server/internal-api/listener-config').observer(source);
    if (!source.MULTITENANT_REALTIME_ROUTES) throw new Error('Explicit admitted routing view required');
    const placement = require('../../lib/realtime-placement').load({ ...source, MULTITENANT_REALTIME_PLACEMENT: source.MULTITENANT_REALTIME_ROUTES }, { internal });
    const edge = create({ resolver, placement });
    edge.server.once('error', () => { void edge.close().catch(() => {}); process.exitCode = 1; });
    edge.server.listen(1343, '0.0.0.0');
    let closing;
    for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => { closing ||= (async()=>{require('./connection-budget-runtime').beginQuiesce();await edge.close();await require('./connection-budget-runtime').finalizeQuiescence(true);})().catch(() => { process.exitCode = 1; }); });
  } catch (error) { await resolver.close(); throw error; }
}
if (require.main === module) main().catch(() => { process.stderr.write('Socket edge unavailable\n'); process.exitCode = 1; });
module.exports = { create, main };
