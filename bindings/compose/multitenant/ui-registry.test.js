'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ui = require('./ui-registry');
const config = () => ({ version: 2, registry: { connectionEnv: 'UI_REGISTRY_PG', namespace: 'ui_registry', maxTenants: 2, refreshMs: 250, maxInflight: 2 }, theme: 'modern' });
const core = process.env.NS_UI_TEST_CORE;
const request = (host, extra = {}) => ({ headers: { host, ...extra }, rawHeaders: ['Host', host, ...Object.entries(extra).flat()] });
const resolverFactory = core ? require(path.join(core, 'lib/tenant-registry/resolver')).createRegistryResolver : null;
test('registry UI accepts exact v2 config and rejects source paths, static rosters and unbounded inputs', () => {
  assert.equal(ui.parse(config()).theme, 'modern');
  for (const mutate of [c => { c.tenants = []; }, c => { c.registry.module = '/tmp/provider'; }, c => { c.registry.maxInflight = 0; }, c => { c.registry.maxTenants = 100001; }, c => { c.registry.namespace = 'public'; }, c => { c.registry.connectionEnv = 'invalid'; }, c => { c.theme = 'other'; }]) {
    const value = config(); mutate(value); assert.throws(() => ui.parse(value), /UI_REGISTRY_CONFIG_INVALID/);
  }
});
test('read-only privilege guard refuses clinical/column access, privileged roles and extra definer capability', async () => {
  const base = { rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolreplication: false, rolcreatedb: false, rolcreaterole: false, member: false, data_access: false, extra_definer: false, sequence_access: false };
  await ui.authority({ readOnly: async () => ({ rows: [base] }) }, 'ui_registry');
  for (const key of Object.keys(base)) {
    const row = { ...base, [key]: !base[key] };
    await assert.rejects(ui.authority({ readOnly: async () => ({ rows: [row] }) }, 'ui_registry'), /UI_REGISTRY_AUTHORITY_UNSAFE/);
  }
});
test('actual resolver admits a new alias on revision, refuses removed/private/conflicting hosts and bounds both caches', { skip: !core }, async () => {
  let revision = '1', lookups = 0, at = 0;
  const aliases = new Map([['a.example.test', { tenant: '11111111-1111-4111-8111-111111111111', state: 'active' }]]);
  const store = { revision: async () => revision, entry: async () => { throw new Error('UI must never request tenant attributes'); }, lookup: async (host, kind) => { lookups++; return kind === 'alias' ? aliases.get(host) || null : null; } };
  const reader = ui.create({ settings: ui.parse(config()), store, resolverFactory, resolverOptions: { now: () => at, schedule: () => null, cancel: () => {} } });
  try {
    await reader.start();assert.equal((await reader.resolve(request('a.example.test'))).theme, 'modern');
    await assert.rejects(reader.resolve(request('new.example.test')), /TENANT_HOST_UNKNOWN/);
    aliases.set('new.example.test', { tenant: '22222222-2222-4222-8222-222222222222', state: 'active' });revision='2';await reader.poll();
    assert.equal((await reader.resolve(request('new.example.test'))).theme, 'modern');
    const before=lookups;await reader.resolve(request('new.example.test'));assert.equal(lookups,before);
    for(const host of ['internal.svc.cluster.local','unregistered.example.test'])await assert.rejects(reader.resolve(request(host)), /TENANT_HOST_UNKNOWN/);
    await assert.rejects(reader.resolve(request('a.example.test', { 'x-forwarded-host': 'new.example.test' })), /TENANT_PROXY_UNTRUSTED/);
    await assert.rejects(reader.resolve(request('new.example.test', { 'x-resolved-tenant': aliases.get('a.example.test').tenant })), /TENANT_PROXY_UNTRUSTED/);
    aliases.delete('a.example.test');revision='3';await reader.poll();await assert.rejects(reader.resolve(request('a.example.test')), /TENANT_HOST_UNKNOWN/);
    for(let i=0;i<10;i++){const host='known-'+i+'.example.test';aliases.set(host,aliases.get('new.example.test'));await reader.resolve(request(host));}
    assert.equal(reader.stats().cached,2);assert.ok(reader.stats().evictions>0);
    for(let i=0;i<1050;i++)await reader.resolve(request('unknown-'+i+'.example.test')).catch(()=>{});
    assert.ok(reader.stats().negative<=1024);assert.ok(reader.stats().cached<=2);
    at=1000;await reader.resolve(request('new.example.test'));assert.ok(lookups>before);
  }finally{await reader.close();}
});
test('in-flight unknown hosts have a fixed refusal budget and owned connection closes once', async () => {
  let resolve,closed=0;const hold=new Promise(done=>{resolve=done;});
  const reader=ui.create({settings:ui.parse(config()),store:{},resolverFactory:()=>({start:async()=>{},resolve:()=>hold,poll:async()=>{},stats:()=>({}),close:()=>{}}),close:async()=>{closed++;}});
  const one=reader.resolve({}),two=reader.resolve({});await assert.rejects(reader.resolve({}), /UI_REGISTRY_UNAVAILABLE/);resolve();await Promise.all([one,two]);await reader.close();await reader.close();assert.equal(closed,1);await assert.rejects(reader.resolve({}), /UI_REGISTRY_UNAVAILABLE/);
});
