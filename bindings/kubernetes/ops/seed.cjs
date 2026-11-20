'use strict';

// Runs in the application image with no network, before the Kubernetes workloads exist.
const path = require('node:path');

function main (env = process.env) {
  const app = process.cwd(), root = env.NS_SEED_ROOT || '/seed';
  process.umask(0o077);
  const credentials = path.join(root, 'credentials'), output = path.join(root, 'roles');
  const binding = path.join(app, 'deploy/multitenant');
  const seed = require(path.join(binding, 'credentials')).seed;
  seed(credentials);
  const render = require(path.join(app, 'deploy/multitenant/render'));
  return render.render(render.input({ ...env, NS_CREDENTIALS_DIR: credentials, NS_RENDER_OUTPUT: output, NS_API_VAULT_TOKEN_FILE: '/run/ns-vault/token' }));
}
if (require.main === module) {
  try { console.log(JSON.stringify(main())); }
  catch (error) { console.error(JSON.stringify({ error: error.code || 'K8S_SEED_FAILED' })); process.exitCode = 1; }
}
module.exports = { main };
