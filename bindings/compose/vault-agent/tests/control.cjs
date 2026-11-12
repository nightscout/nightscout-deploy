'use strict';
const fs = require('node:fs'), vm = require('node:vm'), Module = require('node:module'), crypto = require('node:crypto');
const mode = process.env.NS_AGENT_TEST_CONTROL;
const edits = {
  union: ["const response = await request('sys/auth'), auth = response.data || response;", "for (const tenant of rows[0].config.tenants || []) await request('sys/policies/acl/imported-' + tenant.id); const response = await request('sys/auth'), auth = response.data || response;"],
  'static-only': ['if (next.registry && next.tenants === undefined', 'if (false && next.registry && next.tenants === undefined'],
  'omit-replica': ['const rows = names.map((name, index) => {', 'const rows = names.slice(0, 1).map((name, index) => {']
};
if (!Object.hasOwn(edits, mode)) throw new Error('AGENT_CONTROL_REQUIRED');
const filename = require.resolve('../vault-agent-bootstrap'), source = fs.readFileSync(filename, 'utf8'), [before, after] = edits[mode];
if (source.split(before).length !== 2) throw new Error('AGENT_CONTROL_SOURCE_MISMATCH');
require(filename); const output = { exports: {} };
vm.runInThisContext('(function(require,module,exports){' + source.replace(before, after).replace(/^#![^\n]*\n/, '\n') + '\n})', { filename })(Module.createRequire(filename), output, output.exports);
require.cache[filename].exports = output.exports;
console.log(JSON.stringify({ control: mode, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), inMemoryOnly: true }));
