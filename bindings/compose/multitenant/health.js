'use strict';

// No database credential or query. API/realtime listeners open only after their
// actual role boot/readiness; private IPC must have been published as well.
const fs = require('node:fs');
const net = require('node:net');
const role = process.argv[2];
// Each role process serves its internal contracts on one serve.internal socket.
const roles = {api: {port: 1337}, realtime: {port: 1339}, evaluator: {}, 'tenant-admin': {port: 1341}};
async function main () {
  if (role === 'admin') {
    const response = await fetch('http://127.0.0.1:1342/v1/openapi.json', {signal: AbortSignal.timeout(1500)});
    if (!response.ok || typeof (await response.json()).openapi !== 'string') throw new Error();
    return;
  }
  if (role === 'ui') {
    const response = await fetch('http://127.0.0.1:1340/healthz', {signal: AbortSignal.timeout(1500)});
    if (!response.ok || await response.text() !== 'ok\n') throw new Error();
    return;
  }
  if (!Object.hasOwn(roles, role)) throw new Error();
  require('./load-env');
  const spec = roles[role];
  const own = require('../../lib/server/internal-api/listener-config').resolve([role], process.env);
  const endpoint = own.peer(role, { maxBytes: 1048576, timeoutMs: 1500 });
  if (endpoint.socketPath && !fs.lstatSync(endpoint.socketPath).isSocket()) throw new Error();
  if (spec.port) await new Promise((resolve, reject) => {
    const socket = net.connect({host: '127.0.0.1', port: spec.port});
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.end(); resolve(); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error()); });
    socket.once('error', reject);
  });
  const operation = JSON.parse(fs.readFileSync(process.env.MULTITENANT_OPERATION_CONFIG, 'utf8'));
  const request = require('node:crypto').randomUUID();
  const reply = await require('../../lib/server/internal-api/clients').lifecycleParticipant(endpoint).getStatus({request});
  if (reply.request !== request || reply.participant !== operation.participantId || JSON.stringify(reply.roles) !== JSON.stringify([role])) throw new Error();
}
main().catch(() => { process.exitCode = 1; });
