'use strict';
// Checks bindings/single/targets.json: every target has an owner, a smoke test, a last-verified
// date and an expiry date in the future. An expired target fails; renewing it means re-running
// its smoke test, not editing the date. Exit 0 on success, 1 on any failure.
const fs = require('node:fs');
const file = process.argv[2];
if (!file) { console.error('usage: targets-check.js <targets.json>'); process.exit(2); }
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const required = ['id', 'vendor', 'owner', 'lastVerified', 'expires', 'smokeTest'];
const today = new Date().toISOString().slice(0, 10);
let failures = 0;
if (doc.version !== 1 || !Array.isArray(doc.targets)) { console.error('targets.json: version 1 with a targets array required'); process.exit(1); }
for (const t of doc.targets) {
  const missing = required.filter(k => !t[k]);
  if (missing.length) { failures++; console.error(`${t.id || '(no id)'}: missing ${missing.join(', ')}`); continue; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.expires) || !/^\d{4}-\d{2}-\d{2}$/.test(t.lastVerified)) { failures++; console.error(`${t.id}: dates must be YYYY-MM-DD`); continue; }
  if (t.expires <= today) { failures++; console.error(`${t.id}: expired ${t.expires}; re-run its smoke test to renew`); }
  if (t.lastVerified > today) { failures++; console.error(`${t.id}: lastVerified is in the future`); }
}
console.log(`${doc.targets.length} targets checked, ${failures} failing`);
process.exit(failures ? 1 : 0);
