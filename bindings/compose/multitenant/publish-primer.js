'use strict';

// Explicit local handoff from lab priming custody to the lab operator client.
// It neither provisions database rows nor sends a credential over the network.
const fs = require('node:fs'), path = require('node:path');
function publish(state) {
  const parsed = JSON.parse(fs.readFileSync(path.join(state, 'primer', 'tenants.json'), 'utf8'));
  if (parsed.version !== 1 || !Array.isArray(parsed.tenants)) throw new Error('PRIMER_OUTPUT_INVALID');
  const environment = JSON.parse(fs.readFileSync(path.join(state, 'ops', 'env.json'), 'utf8'));
  for (const [index, row] of parsed.tenants.entries()) {
    if (typeof row.dataToken !== 'string' || !row.dataToken) throw new Error('PRIMER_OUTPUT_INVALID');
    environment[index === 0 ? 'NS_DEMO_TOKEN_A' : index === 1 ? 'NS_DEMO_TOKEN_B' : 'NS_DEMO_TOKEN_' + index] = row.dataToken;
  }
  for (const [name, value] of [['env.json', environment], ['tenants.json', parsed]]) {
    const file = path.join(state, 'ops', name), temporary = file + '.new';
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file);
  }
}
if (require.main === module) { try { publish(process.argv[2]); console.log('Published private synthetic operator inputs'); } catch { console.error('PRIMER_PUBLISH_REFUSED'); process.exitCode = 1; } }
module.exports = { publish };
