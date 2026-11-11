'use strict';

// The admin document this overlay writes must be one core's admin role accepts.
//   node --test bindings/compose/ownership-admin/ownership-grants.test.js
//   NS_CORE_DIR=<cgm-remote-monitor checkout at the SOURCE.md commit> node --test ...   (also runs core's parser)
// Synthetic layout and tenants only.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { adminDocument } = require('./ownership-grants');

const layout = { prefix: 'nsdemo', namespaces: { authorization: 'nsdemo_authorization', control: 'nsdemo_control' } };
const tenants = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
// cgm-remote-monitor 16a1fc2d lib/server/serve/admin-config.js:59 (required and only keys) and :60.
const CORE_OWNERSHIP_KEYS = ['connectionEnv', 'namespace', 'lifecycleNamespace', 'operator', 'tenants'];

test('admin.json carries exactly the ownership keys core requires', () => {
  const doc = adminDocument(layout, tenants);
  assert.deepStrictEqual(Object.keys(doc.ownership).sort(), CORE_OWNERSHIP_KEYS.slice().sort());
  assert.strictEqual(doc.ownership.lifecycleNamespace, 'nsdemo_control');
  assert.notStrictEqual(doc.ownership.lifecycleNamespace, doc.ownership.namespace);
});

test('core admin-config accepts it', { skip: !process.env.NS_CORE_DIR && 'NS_CORE_DIR not set' }, () => {
  const { parse } = require(path.join(process.env.NS_CORE_DIR, 'lib/server/serve/admin-config.js'));
  const parsed = parse(adminDocument(layout, tenants), { NS_OWNERSHIP_PG: 'postgres://nsdemo_ownership_operator:synthetic@postgres:5432/nightscout_compose_test' });
  assert.strictEqual(parsed.ownership.lifecycleNamespace, 'nsdemo_control');
});
