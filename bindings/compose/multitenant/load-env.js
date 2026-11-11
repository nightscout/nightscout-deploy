'use strict';

// Each container receives only its own environment document. Never source it
// through a shell or print a connection string on startup failure.
// Its size bound is core's role-configuration bound (MULTITENANT_CONFIG_MAX_BYTES,
// lib/server/serve/config-file.js), which reaches the container through the
// Compose environment, never through this document. A core without that module
// keeps the former fixed 1 MiB bound.
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.NS_ENV_FILE || '/run/ns-config/env.json';
const reader = path.join(__dirname, '../../lib/server/serve/config-file.js');
const coreBound = fs.existsSync(reader);
function limit () {
  if (!coreBound) return 1048576;
  try { return require(reader).maxBytes(process.env); } catch (error) {
    // The code and range are not secret; the value set is the operator's own.
    process.stderr.write('Private service environment bound is invalid (' + (error?.code === 'CONFIG_FILE_LIMIT_INVALID' ? error.code : 'CONFIG_FILE_READER_FAILED') + ')\n');
    process.exit(78);
  }
}
const maxBytes = limit();
try {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error();
  if (stat.size > maxBytes) {
    process.stderr.write('Private service environment is too large (CONFIG_FILE_TOO_LARGE: ' + stat.size + ' bytes, over the limit of ' + maxBytes + ' bytes, ' + (coreBound ? 'MULTITENANT_CONFIG_MAX_BYTES' : 'fixed: this core has no configurable bound') + ')\n');
    process.exit(78);
  }
  const values = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error();
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0') ||
        ['NODE_OPTIONS', 'NODE_PATH', 'PATH', 'LD_PRELOAD', 'NS_ENV_FILE', 'MULTITENANT_CONFIG_MAX_BYTES'].includes(key)) throw new Error();
  }
  Object.assign(process.env, values);
} catch {
  process.stderr.write('Private service environment is missing or invalid\n');
  process.exit(78);
}
