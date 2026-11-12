#!/usr/bin/env node
'use strict';
// Private operator client. Network admission belongs to the binding; no DB or
// serving credential is given to this process.
const fs = require('node:fs'), path = require('node:path');
const fail = code => Object.assign(new Error(code), { code });
async function configure(config, operation, value, client) {
  if (!['initialize','set','get'].includes(operation)) throw fail('EVALUATOR_POOL_OPERATION_INVALID');
  if (!config.evaluatorPool) {
    if (operation !== 'initialize') throw fail('EVALUATOR_POOL_STANDALONE');
    return { outcome: 'standalone' };
  }
  const workers = config.evaluatorPool.workers;
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 16) throw fail('EVALUATOR_POOL_ROSTER_INVALID');
  if (operation === 'set' && (typeof value !== 'string' || !/^[1-9][0-9]?$/.test(value) || Number(value) > workers)) throw fail('EVALUATOR_POOL_MEMBERS_OUTSIDE_ROSTER');
  client ||= require('../../lib/server/internal-api/clients').poolOperations({ url: config.adminOrigin, trust: 'network', maxBytes: 1048576, timeoutMs: 10000 });
  if (operation === 'get') return client.getPool({ kind: 'evaluator' });
  if (operation === 'initialize') {
    const current = await client.getPool({ kind: 'evaluator' });
    if (current.desired) {
      if (current.desired.members !== workers) throw fail('EVALUATOR_POOL_ALREADY_CONFIGURED');
      return { outcome: 'existing', desired: current.desired };
    }
  }
  const result = await client.setPoolMembers({ kind: 'evaluator', members: operation === 'initialize' ? workers : Number(value) });
  if (!['applied','unchanged'].includes(result.outcome)) throw fail('EVALUATOR_POOL_UPDATE_REFUSED');
  return result;
}
async function main() {
  const [operation, value, ...extra] = process.argv.slice(2);
  if (extra.length) throw fail('EVALUATOR_POOL_OPERATION_INVALID');
  const file = path.join(process.env.NS_PRIMER_STATE || '/run/ns-primer', 'config.json');
  console.log(JSON.stringify(await configure(JSON.parse(fs.readFileSync(file, 'utf8')), operation, value)));
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({error: /^[A-Z_]{1,100}$/.test(error.code || '') ? error.code : 'EVALUATOR_POOL_FAILED'})); process.exitCode = 1; });
module.exports = { configure };
