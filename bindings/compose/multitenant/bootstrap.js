#!/usr/bin/env node
'use strict';

// One-shot provisioning for a dedicated synthetic Compose or Kubernetes database. It consumes the
// credentials seeded before apply (credentials.js, mounted read-only) and creates the PostgreSQL
// roles and Vault tokens from them. Role documents are rendered before apply (render.js); this step
// writes only its own custody (Vault initialization, layout, completion) and never a role document.
// Serving processes never import this module and receive no provisioning credential.
const fs=require('node:fs'),path=require('node:path');
const plan=require('./config');
const fail=code=>Object.assign(new Error(code),{code});
function input(env=process.env) {
  if(env.NS_COMPOSE_BOOTSTRAP!=='1'||!/^\/[\w/.-]+$/.test(env.NS_BOOTSTRAP_OUTPUT||'')||! /^[a-f0-9]{40}$/.test(env.NS_SOURCE_COMMIT||''))throw fail('EXPLICIT_COMPOSE_BOOTSTRAP_REQUIRED');
  let pg;
  if(env.NS_BOOTSTRAP_POSTGRES_URL)pg=new URL(env.NS_BOOTSTRAP_POSTGRES_URL);
  else {
    const password=fs.readFileSync(env.NS_POSTGRES_PASSWORD_FILE,'utf8').trim();
    if(!password)throw fail('BOOTSTRAP_POSTGRES_PASSWORD_REQUIRED');
    pg=new URL('postgres://postgres@postgres:5432/nightscout_compose_test');pg.password=password;
  }
  if(!['postgres:','postgresql:'].includes(pg.protocol)||!pg.username||!pg.password||decodeURIComponent(pg.pathname)!=='/nightscout_compose_test'||pg.search||pg.hash)throw fail('DEDICATED_SYNTHETIC_DATABASE_REQUIRED');
  const vault=new URL(env.VAULT_ADDR||'https://vault:8200');
  const bootstrapVault = new URL(env.NS_BOOTSTRAP_VAULT_ADDR || vault.origin);
  for (const endpoint of [vault, bootstrapVault]) {
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw fail('BOOTSTRAP_VAULT_HTTPS_REQUIRED');
  }
  const credentials=env.NS_CREDENTIALS_DIR||'/run/ns-credentials';
  if(!/^\/[\w/.-]+$/.test(credentials))throw fail('BOOTSTRAP_CREDENTIALS_REQUIRED');
  const deployCommit=env.NS_DEPLOY_COMMIT||env.NS_SOURCE_COMMIT;
  if(!/^[a-f0-9]{40}$/.test(deployCommit))throw fail('BOOTSTRAP_DEPLOY_IDENTITY_INVALID');
  return {deployCommit,pg,vault,bootstrapVault,credentials:path.resolve(credentials),output:path.resolve(env.NS_BOOTSTRAP_OUTPUT),sourceCommit:env.NS_SOURCE_COMMIT};
}
// Bootstrap custody files stay indented for the people who read them.
function writePrivate(filename,value) {
  fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
  fs.writeFileSync(filename,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
}
function loginSQL(role,password) {
  if(!/^[a-f0-9]{64}$/.test(password))throw fail('SEEDED_CREDENTIAL_INVALID');
  return 'CREATE ROLE '+plan.quote(role)+" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '"+password+"'";
}
// A restored or repeated lab must be writer-driven, the only input transport. Writer-driven
// fixtures carry no subscriptions, so they are K-free: one seed serves any evaluator K (decision
// statefulset-ordinal-scaling, amended 2026-11-20). A pgstream or unmarked fixture is refused.
function restoreCheck(complete){
  if(complete.inputTransport!=='writer-driven')throw fail('BOOTSTRAP_INPUT_TRANSPORT_CHANGED_RECREATE_DEMO');
}
async function bootstrap(options) {
  const workers=require('./evaluator-workers'),evaluatorWorkers=workers.selection();
  const {pg,bootstrapVault = options.vault,output,sourceCommit,deployCommit}=options;
  const privateDirectory=path.join(output,'bootstrap');fs.mkdirSync(privateDirectory,{recursive:true,mode:0o700});
  const initFile=path.join(privateDirectory,'vault-init.json'),completeFile=path.join(privateDirectory,'complete.json'),startedFile=path.join(privateDirectory,'started.json');
  async function request(resource,body,token,method=body===undefined?'GET':'POST'){
    const response=await fetch(bootstrapVault.origin+'/v1/'+resource,{method,headers:{'Content-Type':'application/json',...(token?{'X-Vault-Token':token}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual',signal:AbortSignal.timeout(10000)});
    if(!response.ok){await response.body?.cancel();throw fail('BOOTSTRAP_VAULT_REFUSED');}
    return response.status===204?{}:response.json();
  }
  let initialization;
  // Only repeat the read. An ambiguous initialization or unseal must never be replayed.
  let status;
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      status = await request('sys/init');
      break;
    } catch (error) {
      if (Date.now() >= deadline || !['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.cause?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  // Vault's own unseal key and root token come from initialization and stay in this step's
  // private state; the role tokens below carry seeded ids.
  if(!status.initialized){
    if(fs.existsSync(initFile))throw fail('BOOTSTRAP_VAULT_STATE_CHANGED');
    initialization=await request('sys/init',{secret_shares:1,secret_threshold:1});
    writePrivate(initFile,initialization);
  }else{
    if(!fs.existsSync(initFile))throw fail('BOOTSTRAP_VAULT_CUSTODY_MISSING');
    initialization=JSON.parse(fs.readFileSync(initFile,'utf8'));
  }
  const seal=await request('sys/seal-status');
  if(seal.sealed){const unsealed=await request('sys/unseal',{key:initialization.keys_base64[0]});if(unsealed.sealed)throw fail('BOOTSTRAP_VAULT_UNSEAL_REFUSED');}
  if(fs.existsSync(completeFile)){
    // An existing lab (a repeat up, or a restored fixture snapshot at another core or deploy
    // commit) is brought forward with migrate up; the roles' readiness checks decide the rest.
    const complete=JSON.parse(fs.readFileSync(completeFile,'utf8'));
    restoreCheck(complete);
    const l=plan.layout(),admin=new (require('pg').Client)({connectionString:pg.toString(),connectionTimeoutMillis:10000,statement_timeout:10000});
    await admin.connect();
    try{
      const seeded=require('./credentials').read(options.credentials,Object.keys(l.roles));
      if(!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[l.roles.owner_settings])).rowCount){
        await admin.query(loginSQL(l.roles.owner_settings,seeded.postgres.owner_settings));
      }
      await migrate(admin,pg,l,plan.catalogues(),false);
    }finally{await admin.end();}
    const seededFrom=complete.seededFrom||complete.sourceCommit;
    if(complete.sourceCommit!==sourceCommit||complete.deployCommit!==deployCommit){
      require('./render').write(completeFile,JSON.stringify({...complete,sourceCommit,deployCommit,seededFrom},null,2)+'\n');
    }
    return {state:'existing-demo-unsealed',sourceCommit,seededFrom};
  }
  if(fs.existsSync(startedFile))throw fail('BOOTSTRAP_PARTIAL_RECREATE_DEMO');
  const l=plan.layout(),q=plan.quote,allCatalogues=plan.catalogues();
  const seeded=require('./credentials').read(options.credentials,Object.keys(l.roles));
  writePrivate(startedFile,{version:2,sourceCommit,deployCommit});
  const {Client}=require('pg'),admin=new Client({connectionString:pg.toString(),connectionTimeoutMillis:10000,statement_timeout:10000});
  await admin.connect();
  try{
    // This script owns a dedicated database. It never adopts existing application
    // schemas/roles; a partial run must be inspected and its demo volumes replaced.
    const preexisting=await admin.query('SELECT nspname FROM pg_namespace WHERE nspname LIKE $1',[l.prefix+'_%']);
    const roles=await admin.query('SELECT rolname FROM pg_roles WHERE rolname LIKE $1',[l.prefix+'_%']);
    if(preexisting.rows.length||roles.rows.length)throw fail('BOOTSTRAP_OBJECTS_ALREADY_EXIST');
    await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await admin.query('REVOKE CREATE ON DATABASE '+q(decodeURIComponent(pg.pathname.slice(1)))+' FROM PUBLIC');
    await admin.query('CREATE ROLE '+q(l.owner)+' NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');
    await admin.query('CREATE ROLE '+q(l.managementAuthorityOwner)+' NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');
    // credentials.read admits hex only, so the literal cannot break out of its quotes.
    for(const [kind,role]of Object.entries(l.roles))await admin.query(loginSQL(role,seeded.postgres[kind]));
    // Clinical output producers/deliverers may use PostgreSQL's reserved_connections
    // slots; REST-serving roles may not (clinical-isolation.js).
    for(const sql of require('./clinical-isolation').grants(l))await admin.query(sql);
    await migrate(admin,pg,l,allCatalogues,true);
    const managementGrants=require('../../lib/management-sessions/authority').grants({namespaces:{registry:l.namespaces.registry,authorization:l.namespaces.authorization,access:l.namespaces.access,control:l.namespaces.control},issuer:l.roles.management_issuer,authorityOwner:l.managementAuthorityOwner});
    for(const sql of [...managementGrants.authorityOwner,...managementGrants.issuer])await admin.query(sql);
    const settings = require('../../lib/server/serve/deployment-settings').evaluator({NS_PG_PREFIX:l.prefix});
    const installOutput = require('./output-grants').outputGrants({layout:l,consumer:settings.consumer});
    await installOutput(admin);
    // S1's ordinary API write-clock transaction updates the existing tenant-bound work row.
    const namespace = q(l.namespaces.eval_checkpoint), writer = q(l.roles.api);
    await admin.query('GRANT USAGE ON SCHEMA '+namespace+' TO '+writer);
    await admin.query('GRANT SELECT(tenant_id,consumer,work_version,work_observed,work_pending_at), '+
      'UPDATE(work_observed,work_observed_at,work_pending_at) ON '+namespace+'.tenant_consumer_checkpoint TO '+writer);
    // Registry completion runs before the admin client closes.
    const result=await require('./registry-bootstrap').finish({request,rootToken:initialization.root_token,layout:l,tokens:seeded.vault,admin});
    writePrivate(path.join(privateDirectory,'layout.json'),l);
    writePrivate(completeFile,{version:2,sourceCommit,deployCommit,registryMode:true,inputTransport:'writer-driven',evaluatorWorkers:evaluatorWorkers?.workers});
    return {...result,sourceCommit};
  }finally{await admin.end();}
}
// Creates (fresh) or brings forward (existing) every catalogue schema, then applies the grants.
// Objects a migration adds are handed to the catalogue owner; existing owners are left alone.
async function migrate(admin,pg,l,catalogues,fresh){
  const q=plan.quote,{run}=require('../../lib/migrations/postgres');
  for(const [kind,catalogue]of Object.entries(catalogues)){
    const namespace=l.namespaces[kind];
    if(fresh)await admin.query('CREATE SCHEMA '+q(namespace));
    await run('up',{direct:true,connectionString:pg.toString(),namespace,catalogue,statementTimeoutMs:10000});
    // Readiness requires immutable catalogue owners without LOGIN/bypass.
    const tables=await admin.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1 AND tableowner=current_user',[namespace]);
    for(const row of tables.rows)await admin.query('ALTER TABLE '+q(namespace)+'.'+q(row.tablename)+' OWNER TO '+q(l.owner));
    // The schema contains only functions from the admitted source catalogue. regprocedure
    // preserves exact argument signatures.
    const functions=await admin.query('SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND pg_get_userbyid(p.proowner)=current_user',[namespace]);
    for(const row of functions.rows)await admin.query('ALTER FUNCTION '+row.signature+' OWNER TO '+q(l.owner));
    if(fresh)await admin.query('ALTER SCHEMA '+q(namespace)+' OWNER TO '+q(l.owner));
  }
  for(const sql of plan.grants(l,{nativeSelection:plan.nativeSelection(l.prefix)}))await admin.query(sql);
}
// Failure report: the stable code first (unchanged contract), then the underlying message and the
// top stack frames so an uncoded refusal (for example a core config loader's size limit) is
// diagnosable from the bootstrap output alone. Credentials never appear: URL userinfo, password
// clauses, Vault tokens, JWT-shaped strings and long hex runs (generated passwords) are redacted.
function redact(text){
  return String(text).slice(0,2000)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]*@/gi,'$1<redacted>@')
    .replace(/\b(password|passwd|pwd|secret|token)(\s*[=:]\s*)('[^']*'|"[^"]*"|[^\s,;&)]+)/gi,'$1$2<redacted>')
    .replace(/\b(password)(\s+)('[^']*'|"[^"]*")/gi,'$1$2<redacted>')
    .replace(/\bhv[sbr]\.[A-Za-z0-9_-]{8,}/g,'<redacted-vault-token>')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]*){1,2}/g,'<redacted-jwt>')
    .replace(/\b[a-f0-9]{32,}\b/gi,'<redacted-hex>');
}
function report(error){
  const code=/^[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'COMPOSE_BOOTSTRAP_FAILED';
  const frames=String(error?.stack||'').split('\n').filter(line=>/^\s+at /.test(line)).slice(0,3)
    .map(line=>redact(line.trim().slice(3).replace(/(\(|^)\/opt\/app\//,'$1')));
  const out={error:code,detail:redact((error?.name&&error.name!=='Error'?error.name+': ':'')+(error?.message??String(error)))};
  if(frames.length)out.at=frames;
  if(error?.cause)out.cause=redact(error.cause?.message??String(error.cause));
  return out;
}
if(require.main===module){Promise.resolve().then(()=>{if(process.argv.length>2)throw fail('BOOTSTRAP_USAGE');return bootstrap(input());}).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{process.stderr.write(JSON.stringify(report(error))+'\n');process.exitCode=1;});}
module.exports={input,writePrivate,bootstrap,redact,report,restoreCheck};
