'use strict';
// Preparation evaluates the admitted pure source configuration graph. No role
// service, PG constructor, network, database credentials or SQL is used here.
const B=require('./connection-budget');
function sourceDocuments(){
 const P=require('./config'),layout=P.layout();
 const u=new URL('postgres://postgres:5432/nightscout_compose_test');u.username='synthetic';u.password='synthetic';
 const urls=Object.fromEntries(Object.keys(layout.roles).map(key=>[key,u.toString()]));
 const realtime=require('./realtime-workers');
 return P.documents({layout,urls,tokens:[],publicKeys:[],managementKeys:[],vaultAddress:'https://vault:8200',registryMode:true,realtimePlacement:realtime.initial(realtime.selection())});
}
function resolve(profile,{source}){
 if(source.coreCommit!==B.REVIEWED_CORE_COMMIT)throw Object.assign(new Error('CONNECTION_BUDGET_UNREVIEWED_SOURCE'),{code:'CONNECTION_BUDGET_UNREVIEWED_SOURCE'});
 const selected=structuredClone(profile),derived=selected.resource?.serverMaximum==='DERIVE_DECLARED';
 const candidate=structuredClone(selected);
 if(candidate.resource?.systemIdentifier==='OBSERVE_AT_BOOTSTRAP')candidate.resource.systemIdentifier='0';
 if(candidate.resource?.postmasterStartedAt==='OBSERVE_AT_BOOTSTRAP')candidate.resource.postmasterStartedAt='preparation-only';
 if(derived)candidate.resource.serverMaximum=1000000;
 const plan=B.compile(candidate,sourceDocuments(),{source,poolConfig:require('../../lib/server/serve/pool-config')});
 const required=plan.declaredMaximum+plan.outside+plan.resource.reserved.superuser+plan.resource.reserved.other;
 if(derived)selected.resource.serverMaximum=required;
 return{profile:selected,requiredMaximum:required,derived,slots:plan.slots.map(x=>x.processInstanceId)};
}
module.exports={sourceDocuments,resolve};
if(require.main===module){try{
 if(process.argv.length!==3||process.argv[2]!=='inventory')throw Error('CONNECTION_BUDGET_INVENTORY_ARGUMENTS');
 const path=require('node:path'),build=require('./build'),root=path.resolve(__dirname,'../..');
 // Admit clean exact source and overlay before config/source modules execute.
 const coreCommit=build.assertCleanSource(root),deployCommit=build.overlay(root)?.deployCommit;
 if(coreCommit!==B.REVIEWED_CORE_COMMIT||!/^[a-f0-9]{40}$/.test(deployCommit||''))throw Error('CONNECTION_BUDGET_UNREVIEWED_SOURCE');
 const descriptors=B.describe(sourceDocuments(),require('../../lib/server/serve/pool-config'));
 process.stdout.write(JSON.stringify({kind:'reviewed-source-constructor-inventory',source:{coreCommit,deployCommit},authorization:'INVENTORY_NOT_ADMISSION',descriptors})+'\n');
}catch(error){process.stderr.write(JSON.stringify({error:/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:'CONNECTION_BUDGET_INVENTORY_REFUSED'})+'\n');process.exitCode=1;}}
