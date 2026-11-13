'use strict';

// In-container driver for the ownership drills, mounted read-only into the binding's private
// `primer` service (the lab client that holds synthetic root custody). It uses the shipping
// ownership-operations client and the tenant's own authorization API. It never bypasses the
// expected-owner comparison: a replay sends exactly what the first attempt sent.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const app = process.cwd();
const primer = require(path.join(app, 'deploy/multitenant/prime.js'));
const directory = process.env.NS_PRIMER_STATE || '/run/ns-primer', notes = process.env.NS_DRILL_STATE || '/run/ns-drill-state';
const code = error => /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'DRILL_FAILED';
const note = name => path.join(notes, name + '.ownership.json');

async function main ([command, name]) {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(name || '')) throw Object.assign(new Error('DRILL_USAGE'), { code: 'DRILL_USAGE' });
  const config = primer.load(path.join(directory, 'config.json'));
  const row = JSON.parse(fs.readFileSync(path.join(directory, 'provisioned.json'), 'utf8'))[1];
  const ownership = require(path.join(app, 'lib/server/internal-api/clients')).ownershipOperations({ url: config.adminOrigin, trust: 'network', maxBytes: 1048576, timeoutMs: 10000 });
  if (command === 'prepare') {
    // A second synthetic subject on the other tenant, and the owner set as it stands now.
    const headers = { host: row.hosts[0], 'api-secret': crypto.createHash('sha1').update(row.rootSecret).digest('hex') };
    const label = 'Synthetic drill owner ' + crypto.randomUUID().slice(0, 8);
    const created = await primer.request(config.apiOrigin, '/api/v2/authorization/subjects', { method: 'POST', body: { name: label, roles: ['demo'] }, headers });
    if (created.status < 200 || created.status >= 300) throw Object.assign(new Error('DRILL_SUBJECT_REFUSED'), { code: 'DRILL_SUBJECT_REFUSED' });
    const subjects = (await primer.request(config.apiOrigin, '/api/v2/authorization/subjects', { headers })).body;
    const subject = subjects.find(item => item.name === label);
    const listed = await ownership.listOwners({ tenant: row.id });
    fs.writeFileSync(note(name), JSON.stringify({ tenant: row.id, owner: { principal: subject._id, consumer: config.ownerConsumer }, expectedOwners: listed.owners.map(o => ({ principal: o.principal, consumer: o.consumer })) }) + '\n', { mode: 0o600 });
    return { step: 'prepare', owners: listed.owners.length };
  }
  const saved = JSON.parse(fs.readFileSync(note(name), 'utf8'));
  if (command === 'list') { const listed = await ownership.listOwners({ tenant: saved.tenant }); return { step: 'list', outcome: listed.outcome, owners: listed.owners.length }; }
  if (command === 'add') {
    const reply = await ownership.addOwner({ tenant: saved.tenant, owner: saved.owner, delegable: ['*'], expectedOwners: saved.expectedOwners });
    return { step: 'add', outcome: reply.outcome, ...(reply.code ? { code: reply.code } : {}) };
  }
  throw Object.assign(new Error('DRILL_USAGE'), { code: 'DRILL_USAGE' });
}
main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'),
  error => { process.stdout.write(JSON.stringify({ error: code(error) }) + '\n'); process.exitCode = 1; });
