#!/usr/bin/env node
'use strict';

// One-shot step after the imported deploy/multitenant/bootstrap.js, in the application image, on
// the private network. It adds the `<prefix>_ownership_operator` database identity the `admin`
// role connects as, with exactly the grants core's deployment plan carries from commit e6f6e248
// (cgm-remote-monitor, deploy/multitenant/config.js: one role name in layout(), six GRANT
// statements in grants()). The imported config.js is read, never edited: its layout() does not
// name this role, so its per-role control-namespace loop never reaches it.
//
// It never prints a credential. The identity's connection string is written to
// /state/ownership-admin/env.json (0600); the admin configuration to admin.json (0600).
//
//   provision   create the role, grant, write the two files, record completion
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const plan = require('/opt/app/deploy/multitenant/config');
const fail = code => Object.assign(new Error(code), { code });
const ROLE = 'ownership_operator';
// Operator identity recorded in the audit rows; synthetic names for the Compose demonstration.
const OPERATOR = { principal: 'compose-operator', consumer: 'compose-admin' };

function input (env = process.env) {
  if (env.NS_OWNERSHIP_GRANTS !== '1' || !/^\/[\w/.-]+$/.test(env.NS_BOOTSTRAP_OUTPUT || '')) throw fail('EXPLICIT_OWNERSHIP_GRANTS_REQUIRED');
  const password = fs.readFileSync(env.NS_POSTGRES_PASSWORD_FILE, 'utf8').trim();
  if (!password) throw fail('BOOTSTRAP_POSTGRES_PASSWORD_REQUIRED');
  const pg = new URL('postgres://postgres@postgres:5432/nightscout_compose_test'); pg.password = password;
  const uid = Number(env.NS_RUNTIME_UID || 1000), gid = Number(env.NS_RUNTIME_GID || 1000);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) throw fail('BOOTSTRAP_RUNTIME_ID_REQUIRED');
  return { pg, output: path.resolve(env.NS_BOOTSTRAP_OUTPUT), uid, gid };
}

// The identity's grants, in the order core's plan emits them.
function grants (l) {
  const q = plan.quote, who = q(l.prefix + '_' + ROLE), ns = name => q(l.namespaces[name]);
  const table = name => ns('authorization') + '.' + q(name);
  return [
    'GRANT USAGE ON SCHEMA ' + ns('authorization') + ' TO ' + who,
    ...['tenant_authorization_config', 'tenant_owner_policy'].map(name => 'GRANT SELECT,UPDATE(owner_fence) ON ' + table(name) + ' TO ' + who),
    'GRANT SELECT,INSERT,UPDATE(active,can_update,delegable) ON ' + table('tenant_owner_actors') + ' TO ' + who,
    'GRANT SELECT ON ' + table('tenant_authorization_subjects') + ' TO ' + who,
    'GRANT INSERT ON ' + table('tenant_subject_admin_audit') + ' TO ' + who
  ];
}

function writePrivate (file, value, { uid, gid }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' });
  fs.chownSync(path.dirname(file), uid, gid); fs.chownSync(file, uid, gid);
}

async function provision ({ pg, output, uid, gid }) {
  const directory = path.join(output, 'ownership-admin'), complete = path.join(directory, 'complete.json');
  if (!fs.existsSync(path.join(output, 'bootstrap', 'complete.json'))) throw fail('IMPORTED_BOOTSTRAP_INCOMPLETE');
  if (fs.existsSync(complete)) return { state: 'ownership-grants-existing' };
  const l = plan.layout(), q = plan.quote, role = l.prefix + '_' + ROLE;
  if (l.roles[ROLE]) throw fail('IMPORTED_PLAN_ALREADY_HAS_OWNERSHIP_OPERATOR'); // the overlay is then redundant
  const { Client } = require('/opt/app/node_modules/pg');
  const admin = new Client({ connectionString: pg.toString(), connectionTimeoutMillis: 10000, statement_timeout: 10000 });
  await admin.connect();
  try {
    if ((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rows.length) throw fail('OWNERSHIP_ROLE_EXISTS_RECREATE_DEMO');
    const password = crypto.randomBytes(32).toString('hex');
    await admin.query('CREATE ROLE ' + q(role) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + password + "'");
    for (const sql of grants(l)) await admin.query(sql);
    const url = new URL(pg); url.username = role; url.password = password;
    const own = { uid, gid };
    writePrivate(path.join(directory, 'env.json'), JSON.stringify({ NS_OWNERSHIP_PG: url.toString() }, null, 2) + '\n', own);
    writePrivate(path.join(directory, 'admin.json'), JSON.stringify({ version: 1, maxBytes: 65536, timeoutMs: 10000,
      ownership: { connectionEnv: 'NS_OWNERSHIP_PG', namespace: l.namespaces.authorization, operator: OPERATOR, tenants: [plan.A, plan.B] } }, null, 2) + '\n', own);
    writePrivate(complete, JSON.stringify({ version: 1, role }) + '\n', own);
    return { state: 'ownership-grants-provisioned', role, grants: grants(l).length };
  } finally { await admin.end(); }
}

if (require.main === module) {
  Promise.resolve().then(() => process.argv[2] === 'provision' ? provision(input()) : Promise.reject(fail('USAGE_PROVISION')))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(JSON.stringify({ error: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'OWNERSHIP_GRANTS_FAILED' }) + '\n'); process.exitCode = 1; });
}
module.exports = { grants, input, provision };
