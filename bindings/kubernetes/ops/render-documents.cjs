'use strict';

// Seed step for the Kubernetes binding (decision provisioning-secrets-in), run by
// scripts/secrets.sh in the application image with the network disabled, before apply:
//   1. seed every role credential (deploy/multitenant/credentials.js) into /seed/credentials;
//   2. render every role document from them (deploy/multitenant/render.js) into /seed/documents,
//      with the api pointed at its Vault Agent sink;
//   3. for the separate-K1 topology, project the internal listener addresses
//      (network-documents.cjs).
// secrets.sh turns both directories into Secrets. Nothing is read back out of a running Pod.
const path = require('node:path');
const SINK = '/run/ns-vault/token';
function main (env = process.env) {
  const app = process.cwd(), root = env.NS_SEED_ROOT || '/seed';
  const topology = env.NS_APPLICATION_TOPOLOGY || 'cohort';
  if (!['cohort', 'separate-k1'].includes(topology)) throw Object.assign(new Error('K8S_TOPOLOGY_INVALID'), { code: 'K8S_TOPOLOGY_INVALID' });
  process.umask(0o077);
  const credentials = path.join(root, 'credentials'), output = path.join(root, 'documents');
  require(path.join(app, 'deploy/multitenant/credentials')).seed(credentials);
  const render = require(path.join(app, 'deploy/multitenant/render'));
  const result = render.render(render.input({ ...env, NS_CREDENTIALS_DIR: credentials, NS_RENDER_OUTPUT: output, NS_API_VAULT_TOKEN_FILE: SINK }));
  if (topology === 'separate-k1') require('./network-documents.cjs').project(output);
  return { ...result, topology };
}
if (require.main === module) {
  try { console.log(JSON.stringify(main())); } catch (error) {
    console.error(JSON.stringify({ error: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'K8S_SEED_RENDER_FAILED' }));
    process.exitCode = 1;
  }
}
module.exports = { main, SINK };
