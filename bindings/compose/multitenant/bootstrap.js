#!/usr/bin/env node
'use strict';

// One-shot provisioning for a dedicated synthetic Compose database. Serving
// processes never import this module and receive no provisioning credential.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const plan=require('./config');
const random=()=>crypto.randomBytes(32).toString('hex');
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
  if(vault.protocol!=='https:'||vault.username||vault.password||vault.pathname!=='/'||vault.search||vault.hash)throw fail('BOOTSTRAP_VAULT_HTTPS_REQUIRED');
  const uid=Number(env.NS_RUNTIME_UID||1000),gid=Number(env.NS_RUNTIME_GID||1000);
  if(!Number.isSafeInteger(uid)||uid<1||!Number.isSafeInteger(gid)||gid<1)throw fail('BOOTSTRAP_RUNTIME_ID_REQUIRED');
  // Off by default. For large tenant counts the generated role documents exceed core's default 1 MiB
  // configuration bound. compose.yaml passes this value to every role container as
  // MULTITENANT_CONFIG_MAX_BYTES (core lib/server/serve/config-file.js, range 65,536..67,108,864);
  // the bootstrap applies it to its own validation of the files. It is never written to env.json.
  const capRaw=env.NS_BOOTSTRAP_CONFIG_MAX_BYTES||'';
  if(capRaw&&(!/^[1-9][0-9]{0,9}$/.test(capRaw)||Number(capRaw)<65536||Number(capRaw)>67108864))throw fail('BOOTSTRAP_CONFIG_MAX_BYTES_INVALID');
  const deployCommit=env.NS_DEPLOY_COMMIT||env.NS_SOURCE_COMMIT;
  if(!/^[a-f0-9]{40}$/.test(deployCommit))throw fail('BOOTSTRAP_DEPLOY_IDENTITY_INVALID');
  return {connectionBudgetProfile:env.NS_CONNECTION_BUDGET_PROFILE_FILE||undefined,deployCommit,pg,vault,output:path.resolve(env.NS_BOOTSTRAP_OUTPUT),sourceCommit:env.NS_SOURCE_COMMIT,uid,gid,configMaxBytes:capRaw?Number(capRaw):undefined};
}
// Generated machine documents (role config, env, admission) are written compact: about a third
// smaller, which matters against the configuration byte cap at large tenant counts. Bootstrap
// custody and operator files stay indented for the people who read them.
function writePrivate(filename,value,{uid,gid}={},{compact=false}={}) {
  fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
  fs.writeFileSync(filename,(compact?JSON.stringify(value):JSON.stringify(value,null,2))+'\n',{mode:0o600,flag:'wx'});
  if(uid!==undefined){fs.chownSync(path.dirname(filename),uid,gid);fs.chownSync(filename,uid,gid);}
}
async function bootstrap(options) {
  // Validate the complete selection before vault, SQL, credentials or files.
  let selected;
  if(options.connectionBudgetProfile){
    const F=require('./connection-budget-files');selected=F.read(options.connectionBudgetProfile);
    if(![1,2].includes(selected.version))throw fail('LIFECYCLE_OPERATOR_SELECTION');
    const marker=path.join(path.dirname(options.connectionBudgetProfile),'operator-enabled.json');
    if(selected.version===2)require('./connection-budget-bootstrap').selection(options,selected,true);
    else if(fs.existsSync(marker)){
      const value=F.read(marker);
      if(!require('node:util').isDeepStrictEqual(value,{version:selected.version,kind:'fresh-lifecycle-operator'}))throw fail('LIFECYCLE_OPERATOR_SELECTION');
      options.lifecycleOperator=true;
    }
  }else if(options.lifecycleOperator)throw fail('LIFECYCLE_OPERATOR_SELECTION');
  require('./pgstream').enabled();
  if(options.connectionBudgetProfile)throw fail('PGSTREAM_EXTERNAL_ADMISSION_UNQUALIFIED');
  const freshControl=!!(options.lifecycleOperator&&selected.version===2);
  const {pg,vault,output,sourceCommit,deployCommit,uid,gid,configMaxBytes}=options;
  const privateDirectory=path.join(output,'bootstrap');fs.mkdirSync(privateDirectory,{recursive:true,mode:0o700});
  const initFile=path.join(privateDirectory,'vault-init.json'),completeFile=path.join(privateDirectory,'complete.json'),startedFile=path.join(privateDirectory,'started.json');
  async function request(resource,body,token,method=body===undefined?'GET':'POST'){
    const response=await fetch(vault.origin+'/v1/'+resource,{method,headers:{'Content-Type':'application/json',...(token?{'X-Vault-Token':token}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual',signal:AbortSignal.timeout(10000)});
    if(!response.ok){await response.body?.cancel();throw fail('BOOTSTRAP_VAULT_REFUSED');}
    return response.status===204?{}:response.json();
  }
  let initialization;
  const status=await request('sys/init');
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
    const complete=JSON.parse(fs.readFileSync(completeFile,'utf8'));
    if(complete.version!==2||complete.sourceCommit!==sourceCommit||complete.deployCommit!==deployCommit)throw fail('BOOTSTRAP_SOURCE_CHANGED_RECREATE_DEMO');
    return {state:'existing-demo-unsealed',sourceCommit};
  }
  if(fs.existsSync(startedFile))throw fail('BOOTSTRAP_PARTIAL_RECREATE_DEMO');
  writePrivate(startedFile,{version:2,sourceCommit,deployCommit});
  const l=plan.layout(),q=plan.quote,allCatalogues=plan.catalogues(),roleURLs={};
  const {Client}=require('pg'),admin=new Client({connectionString:pg.toString(),connectionTimeoutMillis:10000,statement_timeout:10000});
  await admin.connect();
  try{
    // This script owns a dedicated database. It never adopts existing application
    // schemas/roles; a partial run must be inspected and its demo volumes replaced.
    if(options.connectionBudgetProfile){
      const observed=await admin.query("SELECT (SELECT system_identifier::text FROM pg_control_system()) AS \"systemIdentifier\", pg_postmaster_start_time()::text AS \"postmasterStartedAt\", current_setting('max_connections')::int AS \"serverMaximum\", current_setting('superuser_reserved_connections')::int AS \"superuserReserved\", coalesce(current_setting('reserved_connections',true),'0')::int AS \"otherReserved\"");
      if(observed.rows.length!==1)throw fail('CONNECTION_BUDGET_TARGET_UNKNOWN');options.connectionBudgetObserved=observed.rows[0];
    }
    if(freshControl){l.roles.restore_commissioner=l.prefix+'_restore_commissioner';l.roles.realtime_recovery=l.prefix+'_realtime_recovery';}
    const preexisting=await admin.query('SELECT nspname FROM pg_namespace WHERE nspname LIKE $1',[l.prefix+'_%']);
    const roles=await admin.query('SELECT rolname FROM pg_roles WHERE rolname LIKE $1',[l.prefix+'_%']);
    if(preexisting.rows.length||roles.rows.length)throw fail('BOOTSTRAP_OBJECTS_ALREADY_EXIST');
    await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await admin.query('REVOKE CREATE ON DATABASE '+q(decodeURIComponent(pg.pathname.slice(1)))+' FROM PUBLIC');
    await admin.query('CREATE ROLE '+q(l.owner)+' NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');
    await admin.query('CREATE ROLE '+q(l.managementAuthorityOwner)+' NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');
    for(const [kind,role]of Object.entries(l.roles)){
      const password=random();await admin.query('CREATE ROLE '+q(role)+" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '"+password+"'");
      const url=new URL(pg);url.username=role;url.password=password;roleURLs[kind]=url.toString();
    }
    // Setup-only exception: fixed commissioner, no membership/inheritance or
    // application ownership. Runtime verifies its complete effective allowlist.
    if(freshControl)await admin.query('ALTER ROLE '+q(l.roles.restore_commissioner)+' BYPASSRLS NOINHERIT');
    const {run}=require('../../lib/migrations/postgres');
    for(const [kind,catalogue]of Object.entries(allCatalogues)){
      const namespace=l.namespaces[kind];await admin.query('CREATE SCHEMA '+q(namespace));
      await run('up',{direct:true,connectionString:pg.toString(),namespace,catalogue,statementTimeoutMs:10000});
      // Readiness requires immutable catalogue owners without LOGIN/bypass.
      const tables=await admin.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1',[namespace]);
      for(const row of tables.rows)await admin.query('ALTER TABLE '+q(namespace)+'.'+q(row.tablename)+' OWNER TO '+q(l.owner));
      const functions=await admin.query('SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1',[namespace]);
      // The newly created schema contains only functions from the admitted
      // source catalogue. regprocedure preserves exact argument signatures.
      for(const row of functions.rows)await admin.query('ALTER FUNCTION '+row.signature+' OWNER TO '+q(l.owner));
      await admin.query('ALTER SCHEMA '+q(namespace)+' OWNER TO '+q(l.owner));
    }
    for(const sql of plan.grants({...l,roles:Object.fromEntries(Object.entries(l.roles).filter(([name])=>!['restore_commissioner','realtime_recovery'].includes(name)))}))await admin.query(sql);
    if(freshControl)for(const sql of require('./control-recovery-bootstrap').grants(l))await admin.query(sql);
    const managementGrants=require('../../lib/management-sessions/authority').grants({namespaces:{registry:l.namespaces.registry,authorization:l.namespaces.authorization,access:l.namespaces.access,control:l.namespaces.control},issuer:l.roles.management_issuer,authorityOwner:l.managementAuthorityOwner});
    for(const sql of [...managementGrants.authorityOwner,...managementGrants.issuer])await admin.query(sql);
    await require('./pgstream').init({admin,adminURL:pg.toString(),layout:l,config:require('./pgstream').descriptor(l)});
    if(options.connectionBudgetProfile&&require('./connection-budget-files').read(options.connectionBudgetProfile).version===2){
      const database=(await admin.query('SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid"')).rows;
      if(database.length!==1)throw fail('WORKER_DATABASE_IDENTITY');
      options.workerDatabase=require('./worker-database').identity(database[0]);
    }
    if(freshControl){
      options.controlRecoveryPrincipals={};
      for(const [className,role]of [['lifecycle-operator',l.roles.operator],['restore-commissioner',l.roles.restore_commissioner],['realtime-recovery',l.roles.realtime_recovery]]){
        const rows=(await admin.query('SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",rolname AS role,oid::text AS "roleOid" FROM pg_roles WHERE rolname=$1',[role])).rows;
        if(rows.length!==1)throw fail('CONTROL_RECOVERY_PRINCIPAL');options.controlRecoveryPrincipals[className]=require('./control-recovery').principal(rows[0]);
      }
    }
    if(options.lifecycleOperator){const identity=await admin.query('SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",rolname AS role,oid::text AS "roleOid" FROM pg_roles WHERE rolname=$1',[l.roles.operator]);if(identity.rows.length!==1)throw fail('LIFECYCLE_OPERATOR_PRINCIPAL');options.lifecycleOperatorPrincipal=identity.rows[0];}
    return require('./registry-bootstrap').finish({options,request,rootToken:initialization.root_token,layout:l,roleURLs,writePrivate});
  }finally{await admin.end();}
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
if(require.main===module){Promise.resolve().then(()=>bootstrap(input())).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{process.stderr.write(JSON.stringify(report(error))+'\n');process.exitCode=1;});}
module.exports={input,writePrivate,bootstrap,redact,report};
