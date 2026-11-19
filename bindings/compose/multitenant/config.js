'use strict';

// Explicit synthetic deployment plan. No database, network or filesystem I/O.
const clinical = Object.freeze(['entries','treatments','devicestatus','profile','food','activity']);
const ordered = Object.freeze(['entries','treatments','devicestatus','profile','food']);
const serviceRoles = Object.freeze(['api','realtime','evaluator','tenant-admin']);
const { A, B, tenantCount, tenantIds, tenantAlias } = require('./demo-tenants');
const subject = '000000000000000000000001';
function quote(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(name) || name.startsWith('pg_')) throw new TypeError('Explicit deployment SQL identifier required');
  return '"' + name + '"';
}
// Ordinary streaming and its lifetime roles use the same lifecycle catalogue.
function nativeSelection(prefix = 'nsdemo') {
  const settings = require('../../lib/server/serve/deployment-settings');
  return settings.nativeSelection(settings.layout({ NS_PG_PREFIX: prefix }));
}
function catalogues() {
  require('./pgstream').enabled();
  const domains = require('../../lib/server/serve/postgres-domains');
  const successors = require('../../lib/server/tenant-socket-order-port').catalogues;
  return {...Object.fromEntries([...clinical,'settings'].map(name => [name,successors[name] || domains.get(name).catalogue])),
    authorization:require('../../lib/tenant-authorization/postgres-candidate.json'), secrets:require('../../lib/secrets/postgres-candidate.json'),
    legacy:require('../../lib/secrets/legacy-credentials-candidate.json'), access:require('../../lib/tenant-authorization/access-candidate.json'),
    clock:require('../../migrations/candidates/postgres-write-clock-v1.json'), rt_checkpoint:require('../../migrations/candidates/postgres-realtime-output-v2.json'),
    eval_checkpoint:require('../../migrations/candidates/postgres-evaluator-work-v2.json'), alarm:require('../../migrations/candidates/postgres-alarm-suppression-v1.json'),
    outbox:require('../../lib/tenant-notifications/postgres-candidate.json'),control:require('../../lib/tenant-lifecycle/native-selection').catalogue(nativeSelection()),
    registry:require('../../lib/tenant-registry/postgres-candidate.json'),
    display_settings:require('../../lib/tenant-settings/postgres-candidate.json'),
    operator_policy:require('../../lib/operator-policy/postgres-candidate.json'),
    human_session:require('../../lib/human-session/candidate.json'),
    subject_policy:require('../../lib/subject-policy/postgres-candidate.json'),
    owner_configuration:require('../../lib/tenant-settings/owner-authority-candidate.json')};
}
function layout(prefix = 'nsdemo') {
  quote(prefix);
  if (prefix.length > 24) throw new TypeError('Deployment prefix too long');
  const names = ['pgstream','api','readiness','realtime','evaluator','alarm','suppression','outbox','owner_writer','owner_reader','owner_credentials','root_writer','operator','provisioner','display_reader','activity_reader','ownership_operator','connector_writer','management_issuer','ui_registry',
    ...serviceRoles.map(name=>'lifetime_'+name.replace('-','_'))];
  return {prefix,owner:prefix+'_owner',managementAuthorityOwner:prefix+'_management_authority',namespaces:Object.fromEntries(Object.keys(catalogues()).map(name=>[name,prefix+'_'+name])),
    roles:Object.fromEntries(names.map(name=>[name,prefix+'_'+name])),mount:prefix+'_transit'};
}
const { insertionGrants, grants } = require('../../lib/server/ordinary-deployment-grants');
function lifecycle(l) {
  const aliases={rt_checkpoint:'checkpoint',eval_checkpoint:'evaluator_checkpoint',alarm:'alarm_suppression',outbox:'notification_outbox',display_settings:'tenant_settings'};
  const selected=catalogues(), admitted=new Map(require('../../lib/tenant-lifecycle').admittedCatalogue().map(row=>[row.kind,row]));
  const tables={}, extensions={alarm:['tenant_alarm_suppression'],outbox:['tenant_notification_state','tenant_notification_heads','tenant_notification_requests']};
  for(const key of Object.keys(selected).filter(name=>!['control','registry','pool'].includes(name))){
    const kind=aliases[key]||key, row=admitted.get(key==='eval_checkpoint'?'checkpoint':kind);
    if(!row&&!Object.hasOwn(extensions,key))throw new TypeError('Product lifecycle catalogue missing '+kind);
    tables[key]=require('../../lib/tenant-lifecycle/insertion-inventory').tableOrder(kind,selected[key],row?row.tables:extensions[key]);
    const sourceTables=require('../../lib/tenant-operations/catalogues').createdTables(selected[key]);
    if(JSON.stringify([...tables[key]].sort())!==JSON.stringify([...sourceTables].sort()))throw new TypeError('Product lifecycle table inventory mismatch '+kind);
  }
  return {namespaces:Object.fromEntries(Object.entries(l.namespaces).filter(([name])=>!['control','registry','pool'].includes(name)).map(([name,namespace])=>[aliases[name]||name,namespace])),
    catalogues:Object.entries(tables).map(([name,tables])=>({kind:aliases[name]||name,candidate:selected[name],tables,secrets:name==='secrets'?['secret_records']:[]}))};
}
module.exports={A,B,subject,tenantCount,tenantIds,tenantAlias,clinical,ordered,serviceRoles,quote,nativeSelection,catalogues,layout,insertionGrants,grants,lifecycle};
