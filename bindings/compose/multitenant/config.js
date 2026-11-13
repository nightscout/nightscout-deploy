'use strict';

// Explicit synthetic deployment plan. No database, network or filesystem I/O.
const path = require('node:path');
const clinical = Object.freeze(['entries','treatments','devicestatus','profile','food','activity']);
const ordered = Object.freeze(['entries','treatments','devicestatus','profile','food']);
const serviceRoles = Object.freeze(['api','realtime','evaluator','tenant-admin']);
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const subject = '000000000000000000000001';
// Synthetic tenant count: NS_DEMO_TENANTS (default 2 keeps the A/B demonstration
// byte-identical). Tenants 0 and 1 are A and B; later ids are fixed synthetic UUIDs.
// The upper bound is core's preview tenant ceiling (lib/server/serve/tenant-ceiling.js);
// a core without that module keeps this plan's former bound of 10,000 and says so.
let ceiling;
function maxTenants() {
  if (ceiling === undefined) {
    const file = path.join(__dirname, '../../lib/server/serve/tenant-ceiling.js');
    if (require('node:fs').existsSync(file)) ceiling = require(file).PREVIEW_MAX_TENANTS;
    else { ceiling = 10000; process.stderr.write('config: core has no tenant-ceiling module; using the former bound of 10000 tenants\n'); }
  }
  return ceiling;
}
function tenantCount(env = process.env) {
  const raw = env.NS_DEMO_TENANTS === undefined ? '2' : env.NS_DEMO_TENANTS, max = maxTenants();
  if (!/^[1-9][0-9]{0,5}$/.test(raw) || Number(raw) > max) throw new TypeError('NS_DEMO_TENANTS must be 1..' + max);
  return Number(raw);
}
function tenantIds(n = tenantCount()) {
  return Array.from({length: n}, (_, i) => i === 0 ? A : i === 1 ? B
    : (0x30000000 + i).toString(16) + '-3333-4333-8333-' + i.toString(16).padStart(12, '0'));
}
const tenantAlias = i => i === 0 ? 'one.example.test' : i === 1 ? 'two.example.test' : 't' + i + '.example.test';
function quote(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(name) || name.startsWith('pg_')) throw new TypeError('Explicit deployment SQL identifier required');
  return '"' + name + '"';
}
function catalogues() {
  const domains = require('../../lib/server/serve/postgres-domains');
  const successors = require('../../lib/server/tenant-socket-order-port').catalogues;
  return {...(require('./evaluator-workers').selection() ? {pool:require('../../lib/pool-membership/postgres-candidate.json')} : {}),...Object.fromEntries([...clinical,'settings'].map(name => [name,successors[name] || domains.get(name).catalogue])),
    authorization:require('../../lib/tenant-authorization/postgres-candidate.json'), secrets:require('../../lib/secrets/postgres-candidate.json'),
    legacy:require('../../lib/secrets/legacy-credentials-candidate.json'), access:require('../../lib/tenant-authorization/access-candidate.json'),
    clock:require('../../migrations/candidates/postgres-write-clock-v1.json'), rt_checkpoint:require('../../migrations/candidates/postgres-consumer-checkpoint-v1.json'),
    eval_checkpoint:require('../../migrations/candidates/postgres-consumer-checkpoint-v1.json'), alarm:require('../../migrations/candidates/postgres-alarm-suppression-v1.json'),
    outbox:require('../../lib/tenant-notifications/postgres-candidate.json'),control:require('../../lib/tenant-lifecycle/postgres-candidate.json'),
    change_stamps:require('../../lib/change-stamps/postgres-candidate.json'),
    registry:require('../../lib/tenant-registry/postgres-candidate.json'),
    feed:require('../../lib/change-feed/postgres-candidate.json'),
    display_settings:require('../../lib/tenant-settings/postgres-candidate.json'),
    operator_policy:require('../../lib/operator-policy/postgres-candidate.json'),
    human_session:require('../../lib/human-session/candidate.json'),
    subject_policy:require('../../lib/subject-policy/postgres-candidate.json'),
    owner_configuration:require('../../lib/tenant-settings/owner-authority-candidate.json')};
}
function layout(prefix = 'nsdemo') {
  quote(prefix);
  if (prefix.length > 24) throw new TypeError('Deployment prefix too long');
  const names = [...(require('./pgstream').enabled()?['pgstream']:[]),'api','readiness','realtime','evaluator','alarm','suppression','outbox','owner_writer','owner_reader','root_writer','operator','provisioner','display_reader','activity_reader','feed_reader','feed_listener','placement_publisher','ownership_operator','connector_writer','management_issuer','ui_registry',
    ...(require('./evaluator-workers').selection() ? ['pool_member','pool_operator'] : []),
    ...serviceRoles.map(name=>'lifetime_'+name.replace('-','_'))];
  return {prefix,owner:prefix+'_owner',feedOwner:prefix+'_feed_owner',managementAuthorityOwner:prefix+'_management_authority',namespaces:Object.fromEntries(Object.keys(catalogues()).map(name=>[name,prefix+'_'+name])),
    roles:Object.fromEntries(names.map(name=>[name,prefix+'_'+name])),mount:prefix+'_transit'};
}
function insertionGrants({namespace,domain,role,mode='serving'}) {
  const table=quote(namespace)+'.'+quote(domain),who=quote(role);
  if (!['serving','reader','restore'].includes(mode)) throw new TypeError('Explicit grant mode required');
  const isOrdered=ordered.includes(domain);
  if (mode==='reader') return ['GRANT SELECT ON '+table+' TO '+who,...(isOrdered?['GRANT SELECT ON '+quote(namespace)+'.tenant_insertion_ordinal TO '+who]:[])];
  const base=['GRANT SELECT,INSERT,UPDATE,DELETE ON '+table+' TO '+who];
  if (!isOrdered) return base;
  const built=require('../../lib/tenant-lifecycle/tenant-insertion-sql').build({namespace,domain});
  return [...base,...(mode==='restore'?built.restoreGrants(role):built.servingGrants(role)),
    ...(mode==='restore'?['GRANT DELETE ON '+quote(namespace)+'.tenant_insertion_ordinal TO '+who]:[])];
}
function grants(l) {
  const ns=l.namespaces,r=l.roles,sql=[];
  const schema=(name,who)=>sql.push('GRANT USAGE ON SCHEMA '+quote(ns[name])+' TO '+quote(r[who]));
  const table=(name,logical=name)=>quote(ns[name])+'.'+quote(logical);
  const grant=(privilege,name,who)=>sql.push('GRANT '+privilege+' ON '+name+' TO '+quote(r[who]));
  for(const name of [...clinical,'settings','authorization','secrets','legacy','access','clock'])schema(name,'api');
  for(const name of [...clinical,'settings'])sql.push(...insertionGrants({namespace:ns[name],domain:name,role:r.api}));
  for(const name of ['authorization','legacy','access'])grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),'api');
  grant('SELECT,INSERT',table('secrets','secret_records'),'api');grant('INSERT',table('secrets','secret_audit'),'api');
  grant('SELECT,UPDATE(last_stamp,last_delete_stamp)',table('clock','tenant_write_clock'),'api');
  for(const name of [...clinical,'settings','authorization','secrets','legacy','access','clock','alarm']){schema(name,'readiness');grant('SELECT',table(name,'schema_migrations'),'readiness');}
  for(const [who,checkpoint]of [['realtime','rt_checkpoint'],['evaluator','eval_checkpoint']]){
    for(const name of [...clinical,'clock',checkpoint]){schema(name,who);grant('SELECT',table(name,'schema_migrations'),who);}
    for(const domain of clinical)sql.push(...insertionGrants({namespace:ns[domain],domain,role:r[who],mode:'reader'}));
    grant('SELECT',table('clock','tenant_write_clock'),who);grant('SELECT,UPDATE(checkpoint,projection,contract_digest)',table(checkpoint,'tenant_consumer_checkpoint'),who);
  }
  schema('alarm','suppression');for(const name of ['tenant_alarm_suppression','schema_migrations'])grant('SELECT',table('alarm',name),'suppression');
  schema('outbox','outbox');grant('SELECT',table('outbox','schema_migrations'),'outbox');
  grant('SELECT,INSERT,UPDATE(request_id,blocked_until)',table('outbox','tenant_notification_heads'),'outbox');
  grant('SELECT,INSERT,UPDATE(state,next_at,attempt,attempt_token,attempt_until,accepted_at,receipt,cleared_at)',table('outbox','tenant_notification_requests'),'outbox');
  grant('SELECT,INSERT,UPDATE(revision,config_identity,producer)',table('outbox','tenant_notification_state'),'outbox');
  for(const name of ['alarm','authorization','access','outbox'])schema(name,'alarm');
  grant('SELECT,INSERT,UPDATE(acked_at,expires_at)',table('alarm','tenant_alarm_suppression'),'alarm');grant('SELECT',table('alarm','schema_migrations'),'alarm');
  for(const name of ['authorization','access'])grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),'alarm');
  for(const name of ['tenant_notification_state','schema_migrations'])grant('SELECT',table('outbox',name),'alarm');
  for(const who of ['owner_writer','owner_reader'])for(const name of ['authorization','legacy','access']){schema(name,who);grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),who);}
  for(const name of [table('authorization','tenant_authorization_subjects'),table('legacy','legacy_credential_subjects')])grant('INSERT,UPDATE,DELETE',name,'owner_writer');
  grant('INSERT',table('authorization','tenant_authorization_roles'),'owner_writer');
  grant('INSERT,DELETE',table('authorization','tenant_authorization_subject_roles'),'owner_writer');
  sql.push('REVOKE SELECT ON '+table('authorization','tenant_subject_admin_audit')+' FROM '+quote(r.owner_writer));
  grant('INSERT',table('authorization','tenant_subject_admin_audit'),'owner_writer');
  for(const name of ['tenant_authorization_config','tenant_authorization_roles','tenant_owner_policy','tenant_owner_actors'])grant('UPDATE(owner_fence)',table('authorization',name),'owner_writer');
  // Tenant root (API_SECRET) subject administration on the api role: the owner-aware
  // writer's root plane. Reads owner actor rows for the last-owner guard, never locks
  // or writes them; no access schema, no legacy_credential_config, no audit reads.
  for(const name of ['authorization','legacy'])schema(name,'root_writer');
  grant('SELECT,INSERT,UPDATE,DELETE',table('authorization','tenant_authorization_subjects'),'root_writer');
  grant('SELECT,INSERT,UPDATE,DELETE',table('legacy','legacy_credential_subjects'),'root_writer');
  // Root alone edits role permissions and deletes unheld roles (decision root-role-edit-delete).
  grant('SELECT,INSERT,DELETE,UPDATE(permissions,owner_fence)',table('authorization','tenant_authorization_roles'),'root_writer');
  grant('SELECT,INSERT,DELETE',table('authorization','tenant_authorization_subject_roles'),'root_writer');
  grant('INSERT',table('authorization','tenant_subject_admin_audit'),'root_writer');
  for(const name of ['tenant_authorization_config','tenant_owner_policy'])grant('SELECT,UPDATE(owner_fence)',table('authorization',name),'root_writer');
  grant('SELECT',table('authorization','tenant_owner_actors'),'root_writer');
  // The private operator plane uses identities separate from every serving writer.
  schema('authorization','ownership_operator');
  for(const name of ['tenant_authorization_config','tenant_owner_policy']) grant('SELECT,UPDATE(owner_fence)',table('authorization',name),'ownership_operator');
  grant('SELECT,INSERT,UPDATE(active,can_update,delegable)',table('authorization','tenant_owner_actors'),'ownership_operator');
  grant('SELECT',table('authorization','tenant_authorization_subjects'),'ownership_operator');
  grant('INSERT',table('authorization','tenant_subject_admin_audit'),'ownership_operator');
  sql.push(...require('../../lib/tenant-lifecycle/tenant-phase').phaseGrants({namespace:ns.control,role:r.ownership_operator}));
  sql.push(...require('../../lib/tenant-registry/postgres').grants({namespace:ns.registry,readers:[r.ownership_operator]}));
  sql.push(...require('../../lib/tenant-connector/postgres-sources').grants({namespaces:{settings:ns.display_settings,registry:ns.registry,secrets:ns.secrets,control:ns.control},writer:r.connector_writer}));
  // Decision root-writer-fenced: root_writer joins the lower-role window reads; the api opens its
  // subject-admin and read-only settings/activity connections join the tenant
  // operation window; its admission requires these three metadata reads.
  for(const who of Object.keys(r).filter(name=>!['operator','ownership_operator','provisioner','feed_reader','feed_listener','connector_writer','management_issuer','ui_registry','pool_member','pool_operator'].includes(name))){
    schema('control',who);for(const name of ['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'])grant('SELECT',table('control',name),who);
    if(who.startsWith('lifetime_')){
      grant('INSERT(tenant_id,operation_id,generation),UPDATE(finished)',table('control','tenant_lifecycle_operations'),who);
      grant('EXECUTE','FUNCTION '+quote(ns.control)+'.tenant_lifecycle_backend_birth()',who);
    }
  }
  sql.push(...require('../../lib/tenant-lifecycle/maintenance-window').operatorGrants({namespace:ns.control,role:r.operator}));
  sql.push('GRANT pg_read_all_stats TO '+quote(r.operator));
  // Restore's key-retention gate (lib/tenant-lifecycle/key-retention.js admitRestore/markRestored):
  // SELECT request_id,phase,retained_at,retain_until ... WHERE tenant_id=$1 FOR UPDATE, then
  // UPDATE ... SET phase,restored_at WHERE request_id,tenant_id,phase. Nothing else in that table.
  grant('SELECT(request_id,tenant_id,phase,retained_at,retain_until),UPDATE(phase,restored_at)',table('control','tenant_lifecycle_key_retention'),'operator');
  for(const name of Object.keys(ns).filter(name=>name!=='control')){
    schema(name,'operator');grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),'operator');
    if([...clinical,'settings'].includes(name))sql.push(...insertionGrants({namespace:ns[name],domain:name,role:r.operator,mode:'restore'}));
  }
  grant('UPDATE(last_stamp)',table('clock','tenant_write_clock'),'operator');
  // Decision change-stamp-definer-function: search_path pinned, EXECUTE for realtime and evaluator only;
  // both read the function's catalogue ledger at readiness (write-clock-complete: the evaluator adopts it).
  sql.push(...require('../../lib/change-stamps/postgres').grants({namespace:ns.change_stamps,clockNamespace:ns.clock,roles:[r.realtime,r.evaluator]}));
  // The D15 CHECK validator is an invoker function. Its default PUBLIC EXECUTE
  // would violate the private issuer/lifetime identities' exact function surface.
  sql.push('REVOKE ALL ON FUNCTION '+quote(ns.display_settings)+'.tenant_settings_values_valid(jsonb) FROM PUBLIC');
  grant('EXECUTE','FUNCTION '+quote(ns.display_settings)+'.tenant_settings_values_valid(jsonb)','provisioner');
  for(const name of ['display_settings','operator_policy']){schema(name,'display_reader');grant('SELECT','ALL TABLES IN SCHEMA '+quote(ns[name]),'display_reader');}
  schema('control','activity_reader');grant('SELECT',table('control','schema_migrations'),'activity_reader');grant('SELECT',table('control','tenant_activity'),'activity_reader');
  sql.push(...require('../../lib/tenant-registry/postgres').grants({namespace:ns.registry,resolvers:[r.api,r.owner_reader,r.ui_registry,r.realtime],enumerators:[r.realtime,r.evaluator,r.operator,r.placement_publisher],readers:[r.api,r.owner_reader]}));
  sql.push(...require('../../lib/tenant-registry/provision').provisionerGrants({namespaces:require('./registry-plan').provisioningNamespaces(ns),role:r.provisioner,
    checkpoints:[{namespace:ns.rt_checkpoint},{namespace:ns.eval_checkpoint}]}));
  if(ns.pool)sql.push(...require('../../lib/pool-membership/postgres').grants({namespace:ns.pool,member:r.pool_member,operator:r.pool_operator}));
  sql.push(...require('../../lib/trusted-worker/postgres').grants({ namespaces: { activity: ns.control, clock: ns.clock, settings: ns.display_settings, operatorPolicy: ns.operator_policy }, roles: [r.evaluator, r.realtime] }));
  return sql;
}
function documents({layout:l,urls,tokens,publicKeys,managementKeys,vaultAddress,registryMode=false,realtimePlacement=null}) {
  const ns=l.namespaces, base='/run/ns-config',ipc='/run/ns-ipc';
  const domainNamespaces=Object.fromEntries(clinical.map(name=>[name,ns[name]]));
  const ids=tenantIds(),n=ids.length;
  const tenants=ids.map(id=>({id,revision:'compose-demo-v1',settings:{enable:['bgnow','delta','direction','simplealarms','treatmentnotify']}}));
  const aliases=ids.map((_,i)=>[tenantAlias(i)]);
  const limits={pageSize:100,maxRows:10000,maxBytes:8388608,maxTenants:n,recoveryIntervalMs:1000};
  const pgAddress=new URL(urls.evaluator);
  const evaluator={version:1,datastore:{hostname:pgAddress.hostname,port:Number(pgAddress.port||5432),database:decodeURIComponent(pgAddress.pathname.slice(1))},postgres:{connectionEnv:'NS_EVALUATOR_PG',namespaces:{...domainNamespaces,clock:ns.clock,checkpoint:ns.eval_checkpoint,changeStamps:ns.change_stamps}},
    consumer:'evaluator-compose-demo',...limits,timeIntervalMs:1000,socketOrderDomains:['treatments','devicestatus','profile'],tenants,
    consumers:{realtime:{outbox:{connectionEnv:'NS_OUTBOX_PG',namespace:ns.outbox,maxRows:10000,maxBytes:8388608,maxConnections:2},
      suppression:{connectionEnv:'NS_SUPPRESSION_PG',namespace:ns.alarm,maxRows:10000,maxBytes:8388608,maxConnections:2},
      route:{id:'realtime-compose-demo',maxMessageBytes:1048576,operationTimeoutMs:5000},
      maxPayloadBytes:524288,maxInflight:4,attemptTimeoutMs:10000,retryDelayMs:1000,pollIntervalMs:1000,retryIntervalMs:1000}}};
  const realtime={version:1,postgres:{connectionEnv:'NS_REALTIME_PG',namespaces:{...domainNamespaces,clock:ns.clock,checkpoint:ns.rt_checkpoint,changeStamps:ns.change_stamps}},consumer:'realtime-compose-demo',
    ...limits,tenants,socketOrderDomains:['treatments','devicestatus','profile'],admissionFileEnv:'NS_ADMISSION_FILE',
    maxMessageBytes:1048576,operationTimeoutMs:5000,authorizationRecheckMs:30000};
  // Decision root-grant-ceiling-default-all: every tenant data permission unless
  // the operator narrows it. Owner and root share this catalogue (one policy row).
  const ownerCatalogue=['*'];
  const api={version:1,domains:[...clinical,'settings'],legacy:true,context:true,writeClock:true,
    subjectAdmin:{writerConnectionEnv:'NS_API_ROOT_WRITER_PG',ownerPolicy:{catalogue:ownerCatalogue.slice()}},
    postgres:{connectionEnv:'NS_API_PG',readinessConnectionEnv:'NS_READINESS_PG',namespaces:{...domainNamespaces,settings:ns.settings,authorization:ns.authorization,secrets:ns.secrets,legacy:ns.legacy,access:ns.access,clock:ns.clock}},
    vault:{address:vaultAddress,mount:l.mount,timeoutMs:5000},resolution:{mode:'direct-alias'},tenants:tenants.map((tenant,i)=>({id:tenant.id,aliases:aliases[i],settings:tenant.settings,
      vault:{tokenEnv:'NS_VAULT_'+i,encryptionKey:'tenant-'+i+'-data',signingKey:'tenant-'+i+'-signing',signingVersion:1}})),
    accessTokens:{issuer:'nightscout-compose-demo',audience:'nightscout-data',keys:publicKeys},
    socketForwarding:{admissionFileEnv:'NS_ADMISSION_FILE',maxTenants:n,maxMessageBytes:1048576,operationTimeoutMs:5000,
      alarm:{connectionEnv:'NS_ALARM_PG',namespace:ns.alarm},consumerState:{evaluatorConfigEnv:'MULTITENANT_EVALUATOR_CONFIG'}}};
  const owner={version:1,postgres:{writerConnectionEnv:'NS_OWNER_WRITER_PG',accessConnectionEnv:'NS_OWNER_READER_PG',namespaces:{authorization:ns.authorization,credentials:ns.legacy,access:ns.access}},
    ownerPolicy:{catalogue:ownerCatalogue.slice()},resolution:{mode:'direct-alias'},tenants:api.tenants.map(({id,aliases})=>({id,aliases})),
    management:{issuer:'nightscout-compose-management',audience:'nightscout-management',purpose:'management',consumer:'compose-owner',maxLifetimeSeconds:600,keys:managementKeys}};
  const configs={api,realtime,evaluator,'tenant-admin':owner};
  // serve.internal: one socket per role process on the shared private
  // directory; every peer address names the same paths.
  const socketOf=role=>ipc+'/'+role+'.sock';
  const common={...Object.fromEntries(serviceRoles.map(role=>[require('../../lib/server/internal-api/listener-config').envName(role)+'SOCKET',socketOf(role)])),NODE_EXTRA_CA_CERTS:'/run/ns-ca/ca.crt'};
  const own=role=>({NS_SERVE_INTERNAL_SOCKET:socketOf(role)});
  const environments={api:{...common,...own('api'),API_HOSTNAME:'0.0.0.0',API_PORT:'1337',MULTITENANT_PREVIEW_CONFIG:base+'/config.json',MULTITENANT_EVALUATOR_CONFIG:base+'/evaluator-metadata.json',NS_ADMISSION_FILE:base+'/admission.json',NS_API_PG:urls.api,NS_READINESS_PG:urls.readiness,NS_API_ROOT_WRITER_PG:urls.root_writer,NS_ALARM_PG:urls.alarm,...Object.fromEntries(ids.map((_,i)=>['NS_VAULT_'+i,tokens[i]]))},
    realtime:{...common,...own('realtime'),REALTIME_HOSTNAME:'0.0.0.0',REALTIME_PORT:'1339',MULTITENANT_REALTIME_CONFIG:base+'/config.json',NS_ADMISSION_FILE:base+'/admission.json',NS_REALTIME_PG:urls.realtime},
    evaluator:{...common,...own('evaluator'),MULTITENANT_EVALUATOR_CONFIG:base+'/config.json',NS_EVALUATOR_PG:urls.evaluator,NS_OUTBOX_PG:urls.outbox,NS_SUPPRESSION_PG:urls.suppression},
    'tenant-admin':{...common,...own('tenant-admin'),TENANT_ADMIN_HOSTNAME:'0.0.0.0',TENANT_ADMIN_PORT:'1341',MULTITENANT_OWNER_PREVIEW_CONFIG:base+'/config.json',NS_OWNER_WRITER_PG:urls.owner_writer,NS_OWNER_READER_PG:urls.owner_reader}};
  const protectedNamespaces=require('../../lib/server/serve/operation-cohort').protectedNamespaces;
  const participants=serviceRoles.map(role=>({id:role,roles:[role],namespaces:[...new Set([...protectedNamespaces(configs[role]),...(role==='api'?[ns.outbox]:[])])].sort(),maxMessageBytes:1048576,timeoutMs:5000}));
  const locks=ids.map((tenant,i)=>({tenant,key:String(810001+i)})),operations={};
  for(const role of serviceRoles){operations[role]={version:2,namespace:ns.control,connectionEnv:'NS_LIFETIME_PG',locks,participantId:role,participants};Object.assign(environments[role],{NS_LIFETIME_PG:urls['lifetime_'+role.replace('-','_')],MULTITENANT_OPERATION_CONFIG:base+'/operation.json'});}
  const admission={version:1,mode:'preview-socket-allowlist',tenants:api.tenants.map(({id,aliases})=>({id,enabled:true,aliases}))};
  const remote=participants.map(peer=>({id:peer.id,roles:peer.roles,namespaces:peer.namespaces,endpoint:{socketPath:socketOf(peer.id),maxBytes:peer.maxMessageBytes,timeoutMs:peer.timeoutMs}}));
  let docs = {configs,environments,operations,admission,remote,locks,ui:{version:1,tenants:aliases.map(aliases=>({aliases,theme:'default'}))}};
  if(registryMode) docs = require('./registry-plan').expand(docs,{layout:l,urls,vaultAddress});
  else for(const env of Object.values(environments)) env.MULTITENANT_STATIC_TENANTS='lab';
  if (realtimePlacement && !registryMode) throw new TypeError('Realtime placement requires durable registry mode');
  return require('./evaluator-workers').expand(require('./realtime-workers').expand(require('./replicas').expand(docs), realtimePlacement), {layout:l,urls});
}
function lifecycle(l) {
  const aliases={rt_checkpoint:'checkpoint',eval_checkpoint:'evaluator_checkpoint',alarm:'alarm_suppression',outbox:'notification_outbox',display_settings:'tenant_settings'};
  const selected=catalogues(), admitted=new Map(require('../../lib/tenant-lifecycle').admittedCatalogue().map(row=>[row.kind,row]));
  const tables={}, extensions={alarm:['tenant_alarm_suppression'],outbox:['tenant_notification_state','tenant_notification_heads','tenant_notification_requests']};
  for(const key of Object.keys(selected).filter(name=>!['control','change_stamps','registry','feed','pool'].includes(name))){
    const kind=aliases[key]||key, row=admitted.get(key==='eval_checkpoint'?'checkpoint':kind);
    if(!row&&!Object.hasOwn(extensions,key))throw new TypeError('Product lifecycle catalogue missing '+kind);
    tables[key]=require('../../lib/tenant-lifecycle/insertion-inventory').tableOrder(kind,selected[key],row?row.tables:extensions[key]);
    const sourceTables=require('../../lib/tenant-operations/catalogues').createdTables(selected[key]);
    if(JSON.stringify([...tables[key]].sort())!==JSON.stringify([...sourceTables].sort()))throw new TypeError('Product lifecycle table inventory mismatch '+kind);
  }
  return {namespaces:Object.fromEntries(Object.entries(l.namespaces).filter(([name])=>!['control','change_stamps','registry','feed','pool'].includes(name)).map(([name,namespace])=>[aliases[name]||name,namespace])),
    catalogues:Object.entries(tables).map(([name,tables])=>({kind:aliases[name]||name,candidate:selected[name],tables,secrets:name==='secrets'?['secret_records']:[]}))};
}
function validateFiles(directory, docs) {
  const parsers={api:require('../../lib/server/serve/preview-config').load,realtime:require('../../lib/server/realtime/config').load,
    evaluator:require('../../lib/server/serve/evaluator-config').load,'tenant-admin':require('../../lib/server/serve/owner-preview-config').load};
  const namespaces=require('../../lib/server/serve/operation-cohort').protectedNamespaces;
  for(const role of Object.keys(docs.configs)){
    const productRole = role.startsWith('api-') ? 'api' : role.startsWith('realtime-') ? 'realtime' : role.startsWith('evaluator-') ? 'evaluator' : role;
    const env=Object.fromEntries(Object.entries(docs.environments[role]).map(([key,value])=>[key,typeof value==='string'?value.replace('/run/ns-config',path.join(directory,role)).replace('/run/ns-placement',path.join(directory,'placement')):value]));
    const internal=require('../../lib/server/internal-api/listener-config').resolve([productRole],env);
    const parsed=parsers[productRole](env,internal),operation=require('../../lib/server/serve/operation-cohort-config').load(env,internal);
    const participant=operation.participants.find(row=>row.id===operation.participantId);
    if(docs.evaluatorPool){
      const expected=require('./evaluator-workers').services(docs.evaluatorPool),peers=operation.participants.filter(row=>row.roles.includes('evaluator'));
      if(peers.length!==expected.length||expected.some((service,index)=>!peers.some(row=>row.id==='evaluator-'+(index+1)&&row.endpoint.socketPath==='/run/ns-ipc/evaluator-'+(index+1)+'.sock')))throw new TypeError('Deployment evaluator pool coverage mismatch');
      if(productRole==='evaluator'&&(!parsed.partition.partitioned||parsed.partition.ordinal!==expected.indexOf(role)))throw new TypeError('Deployment evaluator ordinal mismatch');
    }
    if(JSON.stringify(namespaces(parsed).filter(name => name !== operation.namespace).sort())!==JSON.stringify(participant.namespaces))throw new TypeError('Deployment participant namespace mismatch');
    if (operation.placement) {
      const map = operation.placement.current(), peers = operation.participants.filter(row => row.roles.includes('realtime'));
      const key = require('../../lib/server/internal-api/listener-config').key;
      if (peers.length !== map.workers.size || new Set(peers.map(row => row.worker)).size !== peers.length ||
          peers.some(row => !map.workers.has(row.worker) || key(row.endpoint) !== key(map.workers.get(row.worker).endpoint))) throw new TypeError('Deployment realtime placement coverage mismatch');
    }
  }
  // The ui's own parser (tenant ceiling, aliases), on the written file when there is one, so a
  // refusal surfaces at bootstrap instead of when the ui starts.
  const uiFile=path.join(directory,'ui','config.json'),fs=require('node:fs');
  require('./ui').parseConfig(fs.existsSync(uiFile)?JSON.parse(fs.readFileSync(uiFile,'utf8')):docs.ui);
}
module.exports={A,B,subject,tenantCount,tenantIds,tenantAlias,clinical,ordered,serviceRoles,quote,catalogues,layout,insertionGrants,grants,documents,lifecycle,validateFiles};
