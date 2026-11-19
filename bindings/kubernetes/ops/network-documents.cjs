'use strict';

// Project only the deployment addresses of source-generated private documents.
// Role/config/lifecycle authority and generations are unchanged.
const fs = require('node:fs');
const path = require('node:path');
const PORTS = Object.freeze({ api: 19001, evaluator: 19002, realtime: 19003, 'tenant-admin': 19004 });
const ROLES = Object.freeze(Object.keys(PORTS));
const key = role => 'NS_' + role.toUpperCase().replaceAll('-', '_') + '_INTERNAL_';
const address = role => 'http://' + role + '-internal:' + PORTS[role] + '/';
const need = ok => { if (!ok) throw Object.assign(new Error('K8S_NETWORK_DOCUMENT_CHANGED'), { code: 'K8S_NETWORK_DOCUMENT_CHANGED' }); };
function environment(env, role) {
  need(ROLES.includes(role));
  const result = Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'NS_SERVE_INTERNAL_SOCKET' && !/^NS_[A-Z_]+_INTERNAL_SOCKET$/.test(name)));
  Object.assign(result, { NS_SERVE_INTERNAL_HOST: '0.0.0.0', NS_SERVE_INTERNAL_PORT: String(PORTS[role]) });
  for (const peer of ROLES) result[key(peer) + 'URL'] = address(peer);
  return result;
}
function project(root) {
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value), { mode: 0o600 });
  for (const role of ROLES) write(role + '/env.json', environment(read(role + '/env.json'), role));
}
module.exports = { PORTS, ROLES, address, environment, project };
