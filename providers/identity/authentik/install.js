'use strict';
// Explicit private one-shot bootstrap only; serving roles never import this file.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const generic=require('../generic-oidc/adapter'),profile=require('./profile');
const fail=generic.fail,q=name=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(name))fail('IDP_SCHEMA_NAME');return '"'+name+'"';};
function grants({human,authority,access,role}){const table=(ns,t)=>q(ns)+'.'+q(t);return[
 ...[human,authority,access].map(ns=>'GRANT USAGE ON SCHEMA '+q(ns)+' TO '+q(role)),
 ...[[human,['human_identities','human_sessions','human_access_tokens','human_logout_events']],[access,['access_tenants','access_credentials','access_keys']],[authority,['tenant_authorization_subjects','tenant_authorization_roles','tenant_authorization_subject_roles','tenant_authorization_config','tenant_owner_actors']]].flatMap(([ns,tables])=>tables.map(t=>'GRANT SELECT ON '+table(ns,t)+' TO '+q(role))),
 'GRANT INSERT,UPDATE ON '+table(human,'human_sessions')+' TO '+q(role),
 'GRANT INSERT ON '+table(human,'human_access_tokens')+','+table(human,'human_logout_events')+' TO '+q(role)];}
function mergeEnvironment(before,adapter,connection,human,layout,signingToken){if(Object.keys(before).some(key=>key.startsWith('OIDC_')))fail('IDP_EXISTING_HUMAN_CONFIG');const selected=generic.environment(adapter);return{...before,...selected,ENABLE:[...new Set((before.ENABLE||'').split(/\s+/).filter(Boolean).concat('oidc'))].join(' '),OIDC_POSTGRES_CONNECTION:connection,OIDC_NAMESPACE:human,OIDC_AUTHORITY_NAMESPACE:layout.namespaces.authorization,OIDC_ACCESS_NAMESPACE:layout.namespaces.access,
 OIDC_HUMAN_VAULT_ADDR:'https://vault:8200',OIDC_HUMAN_VAULT_TOKEN:signingToken,OIDC_ACCESS_CONFIG:JSON.stringify({version:1,registry:true,issuer:'https://sessions-'+adapter.clientId+'.synthetic.invalid',audiences:{data:'idp-human-data',management:'idp-human-management'},vault:{addressEnv:'OIDC_HUMAN_VAULT_ADDR',mount:layout.mount,tokenEnv:'OIDC_HUMAN_VAULT_TOKEN'}})};}
function atomic(file,value){const temporary=file+'.idp-'+crypto.randomBytes(12).toString('hex');try{fs.writeFileSync(temporary,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}
async function install(){
 if(process.env.NS_IDP_INSTALL!=='1')fail('IDP_INSTALL_OPT_IN');
 const root='/run/idp',p=profile.validate(JSON.parse(generic.privateBytes(root+'/private/profile.json'))),provider=JSON.parse(generic.privateBytes(root+'/artifacts/provider.json'));
 if(provider.nonce!==p.nonce||provider.people.length!==p.bindings.length)fail('IDP_PROVIDER_IDENTITY');
 const source=require('/opt/app/deploy/multitenant/bootstrap'),options=source.input(),l=require('/opt/app/deploy/multitenant/config').layout();
 const complete=JSON.parse(generic.privateBytes('/state/bootstrap/complete.json'));
 if(complete.sourceCommit!==p.coreCommit||complete.deployCommit!==p.deployCommit||options.sourceCommit!==p.coreCommit)fail('IDP_SOURCE_IDENTITY');
 const begun='/state/bootstrap/idp-'+p.nonce+'.started.json',done='/state/bootstrap/idp-'+p.nonce+'.complete.json';
 if(fs.existsSync(begun)||fs.existsSync(done))fail('IDP_INSTALL_ALREADY_ATTEMPTED');
 const originals=[...p.apiServices,'tenant-admin'].map(name=>{const file='/state/'+name+'/env.json',before=JSON.parse(generic.privateBytes(file));if(Object.keys(before).some(key=>key.startsWith('OIDC_')))fail('IDP_EXISTING_HUMAN_CONFIG');return{name,file,before};});
 const {Client}=require('/opt/app/node_modules/pg'),client=new Client({connectionString:options.pg.toString(),connectionTimeoutMillis:5000,statement_timeout:5000});
 const human=l.prefix+'_idp_'+p.nonce.slice(0,8),owner=human+'_owner',role=human+'_app',password=crypto.randomBytes(32).toString('hex');
 const authority=l.namespaces.authorization,access=l.namespaces.access;
 try{
  await client.connect();
  for(const row of provider.people){
   if(!p.bindings.some(binding=>binding.tenant===row.tenant&&binding.principal===row.principal&&binding.origin===row.origin&&JSON.stringify(binding.purposes)===JSON.stringify(row.purposes)))fail('IDP_BINDING_CHANGED');
   const alias=(await client.query('SELECT tenant_id,state FROM '+q(l.namespaces.registry)+'.tenant_registry_lookup($1,$2)',[new URL(row.origin).hostname,'alias'])).rows;
   if(alias.length!==1||alias[0].tenant_id!==row.tenant||alias[0].state!=='active')fail('IDP_ORIGIN_NOT_CURRENT');
   const subject=(await client.query('SELECT subject_id FROM '+q(authority)+'.tenant_authorization_subjects WHERE tenant_id=$1 AND subject_id=$2',[row.tenant,row.principal])).rows;
   if(subject.length!==1)fail('IDP_EXISTING_PRINCIPAL_REQUIRED');
   if(row.purposes.includes('management')){const actor=(await client.query('SELECT active FROM '+q(authority)+'.tenant_owner_actors WHERE tenant_id=$1 AND principal=$2 AND consumer=$3',[row.tenant,row.principal,'compose-owner'])).rows;if(actor.length!==1||actor[0].active!==true)fail('IDP_EXISTING_OWNER_AUTHORITY_REQUIRED');const settings=(await client.query('SELECT active,can_configure FROM '+q(l.namespaces.owner_configuration)+'.tenant_owner_configuration_authority WHERE tenant_id=$1 AND principal=$2 AND consumer=$3',[row.tenant,row.principal,'compose-owner'])).rows;if(settings.length!==1||!settings[0].active||!settings[0].can_configure)fail('IDP_EXISTING_SETTINGS_AUTHORITY_REQUIRED');}
  }
  source.writePrivate(begun,{version:1,nonce:p.nonce,source:{core:p.coreCommit,deploy:p.deployCommit}});
  await client.query('CREATE ROLE '+q(owner)+' NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');
  await client.query('CREATE ROLE '+q(role)+" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '"+password+"'");
  await client.query('CREATE SCHEMA '+q(human));
  await require('/opt/app/lib/migrations/postgres').run('up',{direct:true,connectionString:options.pg.toString(),namespace:human,catalogue:require('/opt/app/lib/human-session/candidate.json'),statementTimeoutMs:10000});
  const tables=await client.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1',[human]);
  for(const table of tables.rows)await client.query('ALTER TABLE '+q(human)+'.'+q(table.tablename)+' OWNER TO '+q(owner));
  await client.query('ALTER SCHEMA '+q(human)+' OWNER TO '+q(owner));
  for(const statement of grants({human,authority,access,role}))await client.query(statement);
  await client.query('BEGIN');
  for(let i=0;i<provider.people.length;i++){const row=provider.people[i];await client.query("SELECT set_config('app.current_tenant_id',$1,true)",[row.tenant]);const credential='idp_'+p.nonce.slice(0,8)+'_'+i;
   await client.query('INSERT INTO '+q(access)+'.access_credentials (tenant_id,credential_id,subject_id,generation,enabled) VALUES ($1,$2,$3,1,true)',[row.tenant,credential,row.principal]);
   await client.query('INSERT INTO '+q(human)+'.human_identities (tenant_id,issuer,provider_subject,subject_id,credential_id,enabled,generation,purposes) VALUES ($1,$2,$3,$4,$5,true,1,$6)',[row.tenant,profile.adapter(p).issuer,row.providerSubject,row.principal,credential,row.purposes]);
  }
  await client.query('COMMIT');
  const initialization=JSON.parse(generic.privateBytes('/state/bootstrap/vault-init.json'));
  async function vault(resource,body){const response=await fetch(options.vault.origin+'/v1/'+resource,{method:'POST',headers:{'Content-Type':'application/json','X-Vault-Token':initialization.root_token},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(5000)});if(!response.ok)fail('IDP_VAULT_REFUSED');return response.status===204?{}:response.json();}
  const policy='idp_'+p.nonce,rule=purpose=>'path "'+l.mount+'/sign/tenant-human-'+purpose+'-*" { capabilities = ["update"] }';
  await vault('sys/policies/acl/'+policy,{policy:['data','management'].map(rule).join('\n')});
  const signingToken=(await vault('auth/token/create',{policies:[policy],no_default_policy:true,renewable:true,ttl:'24h'})).auth.client_token;
  const connection=new URL(options.pg);connection.username=role;connection.password=password;
  const selected={...profile.adapter(p),secretFile:root+'/private/client-secret',cookieKeyFile:root+'/private/cookie-key'};
  for(const {name,file,before}of originals){source.writePrivate('/state/bootstrap/idp-'+p.nonce+'-'+name+'.backup.json',before);atomic(file,mergeEnvironment(before,selected,connection.toString(),human,l,signingToken));}
  source.writePrivate(done,{version:1,nonce:p.nonce,source:{core:p.coreCommit,deploy:p.deployCommit},humanNamespace:human,role,owner,people:provider.people.map(({username,...row})=>row),vault:{mode:'static-scoped-human-signer',agentLifecycle:'NOT_MEASURED'}});
  console.log('IDP_HUMAN_BINDING_INSTALLED');
 }finally{await client.end().catch(()=>{});}
}
if(require.main===module)install().catch(error=>{console.error(/^[A-Z0-9_]{1,96}$/.test(error?.code||'')?error.code:'IDP_INSTALL_REFUSED');process.exitCode=1;});
module.exports={grants,mergeEnvironment};
