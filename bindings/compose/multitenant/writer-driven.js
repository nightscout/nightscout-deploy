'use strict';

// JSON is valid Compose YAML. The final overlay gives every sender the same ordinal
// roster, including replicas that extend the base file directly.
function compose(apiReplicas, evaluator, realtime) {
  const api = require('./replicas');
  const evaluators = require('./evaluator-workers').services(evaluator);
  const reals = require('./realtime-workers').services(realtime).filter(name => name !== 'socket-edge');
  const mode = { NS_INPUT_TRANSPORT: 'writer-driven' };
  const settings = {
    ...mode, NS_EVALUATOR_SLICES: String(evaluators.length), NS_REALTIME_SLICES: String(reals.length),
    NS_EVALUATOR_SLICE_URL: 'http://evaluator-{i}.evaluator:19002/',
    NS_REALTIME_SLICE_URL: 'http://realtime-{i}.realtime-peers:19003/',
    NS_EVALUATOR_INTERNAL_SOCKET: '', NS_EVALUATOR_INTERNAL_URL: 'http://evaluator:19002/',
    NS_REALTIME_INTERNAL_SOCKET: '', NS_REALTIME_INTERNAL_URL: 'http://realtime:19003/',
    ...(apiReplicas > 1 ? { NS_API_INTERNAL_SOCKET: '', NS_API_INTERNAL_URL: api.service } : {}),
  };
  const services = { bootstrap: { environment: mode } };
  for (const name of [...api.instances(apiReplicas).map(x => x.service), 'tenant-admin'])
    services[name] = { environment: settings };
  for (const [role, names, domain, port] of [
    ['evaluator', evaluators, 'evaluator', 19002], ['realtime', reals, 'realtime-peers', 19003]
  ]) {
    for (const [ordinal, name] of names.entries()) {
      const hostname = role + '-' + ordinal;
      const peers = reals.map((_, i) => ({url: 'http://realtime-' + i + '.realtime-peers:19003/'}));
      services[name] = {
        hostname, networks: { backend: { aliases: [hostname + '.' + domain] } },
        environment: { ...settings, NS_SERVE_INTERNAL_SOCKET: '', NS_SERVE_INTERNAL_HOST: '0.0.0.0',
          NS_SERVE_INTERNAL_PORT: String(port), ...(role === 'evaluator' ? { NS_REALTIME_SLICE_PEERS: JSON.stringify(peers) } : {}) },
        healthcheck: { test: ['CMD','node','bin/nightscout.js','healthcheck','--endpoint','ready','--url','http://127.0.0.1:' + port + '/healthz/ready'] },
      };
    }
  }
  return JSON.stringify({services}, null, 2) + '\n';
}
module.exports = {compose};
