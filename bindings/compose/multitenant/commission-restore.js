#!/usr/bin/env node
'use strict';

// Explicit private DDL-operator commissioning, after tenant provisioning. Only the recovery drills
// (operator/drills/stack.sh up) and the restore demonstration (demo.sh demo) run it; ordinary
// priming never does. This grants the selected restore identity authority for the synthetic seed cohort;
// serving and provisioning identities cannot grant themselves this authority.
// Existing inactive authority is a revocation and is never reactivated here.
const fs = require('node:fs'), path = require('node:path');
const plan = require('./config'), bootstrap = require('./bootstrap');
const fail = code => Object.assign(new Error(code), { code });
async function commission(options) {
  const complete = JSON.parse(fs.readFileSync(path.join(options.output, 'bootstrap/complete.json'), 'utf8'));
  if (complete.version !== 2) throw fail('RESTORE_COMMISSION_SOURCE_MISMATCH');
  const layout = plan.layout(), q = plan.quote, ns = layout.namespaces;
  const client = new (require('pg').Client)({ connectionString: options.pg.toString(), connectionTimeoutMillis: 10000, statement_timeout: 10000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    const role = (await client.query('SELECT oid,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=$1', [layout.roles.operator])).rows[0];
    if (!role || ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication'].some(name => role[name])) throw fail('RESTORE_COMMISSION_ROLE_REFUSED');
    for (const tenant of plan.tenantIds()) {
      await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      const row = (await client.query('SELECT r.state,w.phase FROM ' + q(ns.registry) + '.tenant_registry r JOIN ' + q(ns.control) + '.tenant_lifecycle_windows w USING(tenant_id) WHERE r.tenant_id=$1', [tenant])).rows[0];
      if (row?.state !== 'active' || row?.phase !== 'active') throw fail('RESTORE_COMMISSION_TENANT_REFUSED');
      const table = q(ns.control) + '.tenant_lifecycle_restore_authority';
      const previous = (await client.query('SELECT active FROM ' + table + ' WHERE tenant_id=$1 AND role_oid=$2', [tenant, role.oid])).rows[0];
      if (previous && previous.active !== true) throw fail('RESTORE_COMMISSION_REVOKED');
      if (!previous) await client.query('INSERT INTO ' + table + ' (tenant_id,role_oid,active) VALUES ($1,$2,true)', [tenant, role.oid]);
    }
    await client.query('COMMIT');
    return { state: 'synthetic-restore-authority-commissioned', tenants: plan.tenantIds().length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {}); throw error;
  } finally { await client.end(); }
}
if (require.main === module) Promise.resolve().then(() => commission(bootstrap.input())).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(JSON.stringify(bootstrap.report(error))); process.exitCode = 1; });
module.exports = { commission };
