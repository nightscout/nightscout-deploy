'use strict';
// Private operator consumer. Audit and decrypt finish before tenant suspension;
// their private SQL pools close before maintenance begins. The callback can
// only consume the exact immutable root reference captured before suspension.
const crypto=require('node:crypto');
const need=(v)=>{if(!v)throw Error('LOCAL_AUTH_PREPARATION_INPUT');};
async function prepare(config,tenant,{rotateSigningKey=false}={},env=process.env){
 need((config?.version===3||config?.tenants?.some(t=>t.id===tenant))&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(tenant)&&typeof rotateSigningKey==='boolean');
 const operator=require('./restore');
 const validated=config.version===3||config.nativeSelection||config.intakeProfile?operator.validateConfig(config,env,false):config;
 const namespaces=config.namespaces,legacy=namespaces.legacy,secretsNamespace=namespaces.secrets;
 for(const n of [legacy,secretsNamespace,config.control.namespace])need(/^[a-z][a-z0-9_]{0,62}$/.test(n)&&!['public','information_schema'].includes(n)&&!n.startsWith('pg_'));
 need(env.NS_OPERATOR_PG&&env.NS_AUTH_AUDIT_PG);
 const {Pool}=require('pg');
 const pool=new Pool({connectionString:env.NS_OPERATOR_PG,max:1,connectionTimeoutMillis:5000,statement_timeout:10000,options:'-c search_path=pg_catalog'});
 let controller,root;
 try {
  const locks=await operator.targetLocks(validated,tenant,pool);
  const scope=require('../../lib/storage/tenant-scope');scope.setTenancyMode('multi');
  const connection=await require('../../lib/storage/postgres-connection')({connectionString:env.NS_AUTH_AUDIT_PG,max:1,connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000});
  let reference;
  try{reference=await connection.withTenant(tenant,async()=>{const rows=(await connection.query('SELECT root_reference_id FROM "'+legacy+'".legacy_credential_config WHERE tenant_id=$1',[tenant])).rows;need(rows.length===1);return rows[0].root_reference_id;});}
  finally{await connection.end();}
  const persistence=await require('../../lib/secrets/postgres').createPostgresSecrets({connectionString:env.NS_AUTH_AUDIT_PG,namespace:secretsNamespace});
  try{
   const rules=require('../../lib/tenant-registry/rules'),layout=require('./config').layout();
   const provider=require('../../lib/secrets/vault-transit').createVaultTransit({address:'https://vault:8200',mount:layout.mount,encryptionKey:rules.vaultKey(tenant,'data'),signingKey:rules.vaultKey(tenant,'signing'),signingVersion:1,getToken:async()=>require('node:fs').readFileSync('/run/ns-config/vault-token','utf8').trim(),timeoutMs:5000});
   const component=require('../../lib/secrets/component').createSecrets({...persistence,providerFor:async t=>{need(t===tenant);return provider;},authorize:async(actor,action)=>actor.tenant===tenant&&actor.principal==='compose-operator'&&actor.consumer==='local-auth-maintenance'&&action.operation==='decrypt'&&action.id===reference});
   root=await component.decrypt({tenant,principal:'compose-operator',consumer:'local-auth-maintenance'},{tenant,id:reference});
  }catch(error){if(Buffer.isBuffer(root))root.fill(0);throw error;}finally{try{await persistence.close();}catch(error){if(Buffer.isBuffer(root))root.fill(0);throw error;}}
  const selection=validated.nativeSelection||validated.intakeProfile?operator.selectionOptions(validated):{};
  controller=require('../../lib/tenant-lifecycle/maintenance-window').create({namespace:config.control.namespace,locks,pool,drainTimeoutMs:config.drainTimeoutMs,...selection});
   const work=require('../../lib/secrets/prepare-local-auth').withMaintenance({controller,namespace:legacy,readRoot:async value=>{need(value.tenant===tenant&&value.id===reference&&Buffer.isBuffer(root));return root;}});
   const artifactDigest=crypto.createHash('sha256').update(JSON.stringify(['local-auth-preparation-v1',tenant,reference,rotateSigningKey])).digest('hex');
   return await work(tenant,{artifactDigest,rotateSigningKey});
 }finally{if(Buffer.isBuffer(root))root.fill(0);try{if(controller)await controller.close();}finally{await pool.end();}}
}
module.exports={prepare};
if(require.main===module){require('./load-env');const fs=require('node:fs');Promise.resolve().then(()=>{const [tenant,selection]=process.argv.slice(2);need(process.argv.length<=4&&[undefined,'--rotate'].includes(selection));const file=process.env.NS_OPERATOR_CONFIG||'/run/ns-config/config.json',stat=fs.lstatSync(file);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<4194304&&!(stat.mode&0o077));return prepare(JSON.parse(fs.readFileSync(file,'utf8')),tenant,{rotateSigningKey:selection==='--rotate'});}).then(()=>console.log(JSON.stringify({prepared:true}))).catch(()=>{console.error('LOCAL_AUTH_PREPARATION_REFUSED');process.exitCode=1;});}
