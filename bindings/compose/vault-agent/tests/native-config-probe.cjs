'use strict';
// Actual production parser; private candidate files only, no SQL or Vault call.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const config = JSON.parse(fs.readFileSync('/state/api/config.json', 'utf8')), environment = JSON.parse(fs.readFileSync('/state/api/env.json', 'utf8'));
const bootstrap = require('/run/agent-bootstrap.cjs'), replicas = require(path.join(process.cwd(), 'deploy/multitenant/replicas'));
const before = crypto.createHash('sha256').update(fs.readFileSync('/state/api/config.json')).digest('hex');
const results = [];
for (const count of [1, 2, 4]) {
  for (const row of replicas.instances(count)) {
    const source = { ...environment };
    if (count === 1) {
      delete source.NS_API_INTERNAL_URL; source.NS_API_INTERNAL_SOCKET = '/run/ns-ipc/api.sock';
      delete source.NS_SERVE_INTERNAL_HOST; delete source.NS_SERVE_INTERNAL_PORT; source.NS_SERVE_INTERNAL_SOCKET = '/run/ns-ipc/api.sock';
    } else {
      delete source.NS_API_INTERNAL_SOCKET; source.NS_API_INTERNAL_URL = 'http://api-internal:7001';
      delete source.NS_SERVE_INTERNAL_SOCKET; source.NS_SERVE_INTERNAL_HOST = '0.0.0.0'; source.NS_SERVE_INTERNAL_PORT = '7001';
    }
    bootstrap.validateApi(config, source, '/state/' + (fs.existsSync('/state/' + row.service) ? row.service : 'api'));
  }
  results.push({ apiReplicas: count, parsersAccepted: count });
}
if (crypto.createHash('sha256').update(fs.readFileSync('/state/api/config.json')).digest('hex') !== before) throw new Error('NATIVE_PARSER_MUTATED_STATE');
console.log(JSON.stringify({ sourceCommit: process.env.NS_SOURCE_COMMIT, results, stateMutated: false, scope: 'production-parser-only' }));
