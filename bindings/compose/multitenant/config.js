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
  require('./pgstream').enabled();
  const domains = require('../../lib/server/serve/postgres-domains');
  const successors = require('../../lib/server/tenant-socket-order-port').catalogues;
  return {...Object.fromEntries([...clinical,'settings'].map(name => [name,successors[name] || domains.get(name).catalogue])),
    authorization:require('../../lib/tenant-authorization/postgres-candidate.json'), secrets:require('../../lib/secrets/postgres-candidate.json'),
    legacy:require('../../lib/secrets/legacy-credentials-candidate.json'), access:require('../../lib/tenant-authorization/access-candidate.json'),
    clock:require('../../migrations/candidates/postgres-write-clock-v1.json'), rt_checkpoint:require('../../migrations/candidates/postgres-realtime-output-v2.json'),
    eval_checkpoint:require('../../migrations/candidates/postgres-evaluator-work-v2.json'), alarm:require('../../migrations/candidates/postgres-alarm-suppression-v1.json'),
    outbox:require('../../lib/tenant-notifications/postgres-candidate.json'),control:require('../../lib/tenant-lifecycle/postgres-candidate.json'),
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
  const names = ['pgstream','api','readiness','realtime','evaluator','alarm','suppression','outbox','owner_writer','owner_reader','owner_credentials','root_writer','operator','provisioner','display_reader','activity_reader','placement_publisher','ownership_operator','connector_writer','management_issuer','ui_registry',
    ...serviceRoles.map(name=>'lifetime_'+name.replace('-','_'))];
  return {prefix,owner:prefix+'_owner',managementAuthorityOwner:prefix+'_management_authority',namespaces:Object.fromEntries(Object.keys(catalogues()).map(name=>[name,prefix+'_'+name])),
    roles:Object.fromEntries(names.map(name=>[name,prefix+'_'+name])),mount:prefix+'_transit'};
}
const { insertionGrants, grants } = require('../../lib/server/ordinary-deployment-grants');
function documents({layout:l,urls,tokens,publicKeys,managementKeys,vaultAddress,registryMode=true,realtimePlacement=null}) {
  if(!registryMode)throw new TypeError('STATIC_PRODUCT_CONFIGURATION_RETIRED');
  const ns=l.namespaces, base='/run/ns-config',ipc='/run/ns-ipc';
  const domainNamespaces=Object.fromEntries(clinical.map(name=>[name,ns[name]]));
  const ids=tenantIds(),n=ids.length;
  const tenants=ids.map(id=>({id,revision:'compose-demo-v1',settings:{enable:['bgnow','delta','direction','simplealarms','treatmentnotify']}}));
  const aliases=ids.map((_,i)=>[tenantAlias(i)]);
  const limits={pageSize:100,maxRows:10000,maxBytes:8388608,maxTenants:n};
  const pgAddress=new URL(urls.evaluator);
  const evaluator={version:1,datastore:{hostname:pgAddress.hostname,port:Number(pgAddress.port||5432),database:decodeURIComponent(pgAddress.pathname.slice(1))},postgres:{connectionEnv:'NS_EVALUATOR_PG',namespaces:{...domainNamespaces,clock:ns.clock,checkpoint:ns.eval_checkpoint}},
    consumer:'evaluator-compose-demo',...limits,timeIntervalMs:1000,socketOrderDomains:['treatments','devicestatus','profile'],tenants,
    consumers:{realtime:{outbox:{connectionEnv:'NS_OUTBOX_PG',namespace:ns.outbox,maxRows:10000,maxBytes:8388608,maxConnections:2},
      suppression:{connectionEnv:'NS_SUPPRESSION_PG',namespace:ns.alarm,maxRows:10000,maxBytes:8388608,maxConnections:2},
      route:{id:'realtime-compose-demo',maxMessageBytes:1048576,operationTimeoutMs:5000},
      maxPayloadBytes:524288,maxInflight:4,attemptTimeoutMs:10000,retryDelayMs:1000,pollIntervalMs:1000,retryIntervalMs:1000}}};
  const realtime={version:1,postgres:{connectionEnv:'NS_REALTIME_PG',namespaces:{clock:ns.clock,checkpoint:ns.rt_checkpoint}},consumer:'realtime-compose-demo',
    maxRows:limits.maxRows,maxBytes:limits.maxBytes,maxTenants:limits.maxTenants,tenants,admissionFileEnv:'NS_ADMISSION_FILE',
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
  const environments={api:{...common,...own('api'),API_HOSTNAME:'0.0.0.0',API_PORT:'1337',MULTITENANT_PREVIEW_CONFIG:base+'/config.json',MULTITENANT_EVALUATOR_CONFIG:base+'/evaluator-metadata.json',NS_ADMISSION_FILE:base+'/admission.json',...require('./clinical-isolation').apiEnvironment(),NS_API_PG:urls.api,NS_READINESS_PG:urls.readiness,NS_API_ROOT_WRITER_PG:urls.root_writer,NS_ALARM_PG:urls.alarm,...Object.fromEntries(ids.map((_,i)=>['NS_VAULT_'+i,tokens[i]]))},
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
  docs = require('./registry-plan').expand(docs,{layout:l,urls,vaultAddress});
  const evaluatorWorkers = require('./evaluator-workers');
  return evaluatorWorkers.expand(require('./realtime-workers').expand(require('./replicas').expand(docs), realtimePlacement), evaluatorWorkers.selection());
}
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
function validateFiles(directory, docs) {
  const evaluated=docs.configs.evaluator;
  if(evaluated.pgstream)for(const [role,config]of Object.entries(docs.configs))if(role==='realtime'||role.startsWith('realtime-')){
    if(config.changeFeed||config.completedOutput?.namespace!==evaluated.postgres.namespaces.checkpoint||config.completedOutput?.consumer!==evaluated.consumer)throw new TypeError('PGSTREAM_COMPLETED_SOURCE_MISMATCH');
  }
  const parsers={api:require('../../lib/server/serve/preview-config').load,realtime:require('../../lib/server/realtime/config').load,
    evaluator:require('../../lib/server/serve/evaluator-config').load,'tenant-admin':require('../../lib/server/serve/owner-preview-config').load};
  const namespaces=require('../../lib/server/serve/operation-cohort').protectedNamespaces;
  for(const role of Object.keys(docs.configs)){
    const productRole = role.startsWith('api-') ? 'api' : role.startsWith('realtime-') ? 'realtime' : role.startsWith('evaluator-') ? 'evaluator' : role;
    const env=Object.fromEntries(Object.entries(docs.environments[role]).map(([key,value])=>[key,typeof value==='string'?value.replace('/run/ns-config',path.join(directory,role)).replace('/run/ns-placement',path.join(directory,'placement')):value]));
    const internal=require('../../lib/server/internal-api/listener-config').resolve([productRole],env);
    const parsed=parsers[productRole](env,internal),operation=require('../../lib/server/serve/operation-cohort-config').load(env,internal);
    const participant=operation.participants.find(row=>row.id===operation.participantId);
    require('./evaluator-workers').validate(docs, role, parsed, operation);
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
