'use strict';
// Fixed reference binding. Only bootstrap's actual source and serving document
// select the native catalogue; neither an artifact nor a provider path can do so.
const native=require('../../lib/tenant-lifecycle/native-selection');
const fail=()=>Object.assign(new Error('COMPOSE_NATIVE_SELECTION_REFUSED'),{code:'COMPOSE_NATIVE_SELECTION_REFUSED'});
async function source(admin,slot){
 const rows=(await admin.query('SELECT s.system_identifier::text AS system_id,c.timeline_id::integer AS timeline,current_database() AS database FROM pg_catalog.pg_control_system() s CROSS JOIN pg_catalog.pg_control_checkpoint() c')).rows;
 if(rows.length!==1)throw fail();
 return require('../../lib/storage/clinical-stream-state').sourceIdentity({...rows[0],slot});
}
function select(layout,docs,identity){
 const evaluator=docs.configs.evaluator;
 if(identity.slot!==evaluator.pgstream.slot||evaluator.postgres.namespaces.checkpoint!==layout.namespaces.eval_checkpoint)throw fail();
 return native.create({namespace:layout.namespaces.eval_checkpoint,lifecycleNamespace:layout.namespaces.control,consumer:evaluator.consumer,source:identity,generation:evaluator.pgstream.generation});
}
function completedPlan(provisioning,selection){
 const {namespace,consumer}=native.validate(selection).binding;
 const rows=provisioning.checkpoints.filter(row=>row.namespace===namespace&&row.consumer===consumer+'-completed');
 const legacy=require('../../lib/pgstream/checkpoint').create({typed:true,connection:{},namespace,consumer,maxBytes:1}).digest;
 if(rows.length!==1||![legacy,selection.contractDigest].includes(rows[0].digest))throw fail();
 return rows[0];
}
function attach(docs,selection){
 const checkpoint=completedPlan(docs.admin.config.provisioning,selection);
 for(const operation of Object.values(docs.operations)){
  if(operation.intakeProfile!==undefined||operation.namespace!==selection.binding.lifecycleNamespace||
    operation.nativeSelection!==undefined&&!require('node:util').isDeepStrictEqual(operation.nativeSelection,selection.binding))throw fail();
 }
 for(const operation of Object.values(docs.operations))operation.nativeSelection=structuredClone(selection.binding);
 checkpoint.digest=selection.contractDigest;
 return docs;
}
function grants(layout,selection){
 native.bind(selection,layout.namespaces.control);
 const privateRoles=['operator','ownership_operator','provisioner','connector_writer','management_issuer','ui_registry','pool_member','pool_operator'];
 return [...Object.entries(layout.roles).filter(([name])=>!privateRoles.includes(name)).flatMap(([,role])=>native.servingGrants({namespace:layout.namespaces.control,role})),
  ...require('../../lib/tenant-lifecycle/maintenance-window').operatorGrants({namespace:layout.namespaces.control,role:layout.roles.operator,nativeSelection:selection})];
}
async function install({admin,adminURL,layout,selection}){
 const namespace=layout.namespaces.control,quote=require('./config').quote;
 native.bind(selection,namespace);
 await upgradeReceipts({admin,adminURL,selection});
 // The baseline objects already have the immutable application owner. Only the
 // new source-owned link is created here; do not adopt other schemas/objects.
 await admin.query('ALTER TABLE '+quote(namespace)+'.tenant_lifecycle_recommission OWNER TO '+quote(layout.owner));
 for(const sql of grants(layout,selection))await admin.query(sql);
 const proof=quote(layout.prefix+'_platform_verification'),operator=quote(layout.roles.operator);
 await admin.query('GRANT USAGE ON SCHEMA '+proof+' TO '+operator);
 await admin.query('GRANT SELECT (role,status,epoch,contract_digest,database_oid,database_name,role_oid,role_name) ON '+proof+'.verified_role TO '+operator);
 await admin.query('GRANT SELECT (singleton,epoch,operation_status) ON '+proof+'.verification_control TO '+operator);
}
async function upgradeReceipts({admin,adminURL,selection}){
 const namespace=native.validate(selection).binding.lifecycleNamespace;
 // Receipts are native-only; the retired receipt cutover (core native-receipt-cutover.js) has no step here.
 await require('../../lib/migrations/postgres').run('up',{direct:true,connectionString:adminURL,namespace,catalogue:native.catalogue(selection),statementTimeoutMs:10000});
 return 0;
}
module.exports={source,select,attach,grants,install,upgradeReceipts};
if(require.main===module){
 (async()=>{
  // A staged provisioning document keeps the operator's existing ownership,
  // permissions and secret distribution under the deployment's control.
  if(process.argv.length!==5||!process.env.NS_RECEIPT_ADMIN_PG)throw fail();
  const fs=require('node:fs');
  const operation=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  if(operation.intakeProfile!==undefined||operation.namespace!==operation.nativeSelection?.lifecycleNamespace)throw fail();
  const selection=native.create(operation.nativeSelection),adminURL=process.env.NS_RECEIPT_ADMIN_PG;
  const admin=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
  completedPlan(admin.provisioning,selection).digest=selection.contractDigest;
  const client=new (require('pg').Client)({connectionString:adminURL});
  try{
   await client.connect();
   await native.assertCurrent(client,selection,{nativeSource:{source:selection.binding.source,generation:selection.binding.generation}});
   const changed=await upgradeReceipts({admin:client,adminURL,selection});
   fs.writeFileSync(process.argv[4],JSON.stringify(admin)+'\n',{mode:0o600,flag:'wx'});
   console.log('Native receipt rows upgraded',changed);
  }
  finally{await client.end();}
 })().catch(error=>{console.error(/^[A-Z0-9_]+$/.test(error.message)?error.message:'NATIVE_RECEIPT_UPGRADE_REFUSED');process.exitCode=1;});
}
