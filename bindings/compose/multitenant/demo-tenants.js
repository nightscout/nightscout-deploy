'use strict';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
// Synthetic tenant count: NS_DEMO_TENANTS (default 2 keeps the A/B demonstration
// byte-identical). Tenants 0 and 1 are A and B; later ids are fixed synthetic UUIDs.
// No fixed tenant ceiling: limits come from measurement, not from this plan.
function tenantCount(env = process.env) {
  const raw = env.NS_DEMO_TENANTS === undefined ? '2' : env.NS_DEMO_TENANTS;
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new TypeError('NS_DEMO_TENANTS must be a positive integer');
  return Number(raw);
}
function tenantIds(n = tenantCount()) {
  return Array.from({length: n}, (_, i) => i === 0 ? A : i === 1 ? B
    : (0x30000000 + i).toString(16) + '-3333-4333-8333-' + i.toString(16).padStart(12, '0'));
}
const tenantAlias = i => i === 0 ? 'one.example.test' : i === 1 ? 'two.example.test' : 't' + i + '.example.test';

module.exports = { A, B, tenantCount, tenantIds, tenantAlias };
