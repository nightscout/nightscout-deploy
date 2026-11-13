'use strict';
const path=require('node:path'),F=require('./connection-budget-files'),B=require('./connection-budget');
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
function prepare({options,docs,writePrivate}){
 const profile=F.read(options.connectionBudgetProfile),observed=options.connectionBudgetObserved;
 need(observed&&profile.resource,'CONNECTION_BUDGET_TARGET_UNKNOWN');
 need(profile.resource.serverMaximum===observed.serverMaximum&&profile.resource.reserved.superuser===observed.superuserReserved&&profile.resource.reserved.other===observed.otherReserved,'CONNECTION_BUDGET_ACTUAL_SETTINGS_CHANGED');
 for(const key of ['systemIdentifier','postmasterStartedAt']){
   need(profile.resource[key]==='OBSERVE_AT_BOOTSTRAP'||profile.resource[key]===observed[key],'CONNECTION_BUDGET_TARGET_CHANGED');
   profile.resource[key]=observed[key];
 }
 let plan=B.compile(profile,docs,{source:{coreCommit:options.sourceCommit,deployCommit:options.deployCommit},poolConfig:require('../../lib/server/serve/pool-config')});
 if(options.lifecycleOperator){
  const fs=require('node:fs'),crypto=require('node:crypto'),digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const placement=!!require('./realtime-workers').selection();
  const lifecycleOperator={version:1,principal:options.lifecycleOperatorPrincipal,tenants:docs.locks.map(r=>r.tenant),placement,files:{'env.json':digest(path.join(options.output,'ops','env.json')),'config.json':digest(path.join(options.output,'ops','config.json')),...(placement?{'placement.json':digest(path.join(options.output,'placement','backend.json'))}:{})}};
  need(lifecycleOperator.principal&&plan.resource.allowances.controlRecovery>=1,'LIFECYCLE_OPERATOR_PRINCIPAL');
  const {sha256,...body}=plan;plan={...body,lifecycleOperator};plan={...plan,sha256:B.hash(plan)};
 }
 for(const env of [...Object.values(docs.environments),docs.admin.environment,docs.feed.environment,docs.uiEnvironment])env.NS_SOURCE_COMMIT=options.sourceCommit;
 const own={uid:options.uid,gid:options.gid},base=path.join(options.output,'connection-budget');
 writePrivate(path.join(base,'plan.json'),plan,own,{compact:true});
 // A private directory mount preserves the reader's parent-custody contract.
 // Workers see only this independent plan copy, never sibling tickets/claims.
 // A hard link would violate the private reader's single-link file invariant.
 writePrivate(path.join(base,'plan-view','plan.json'),plan,own,{compact:true});
 // Each process gets a separate one-use ticket and writable private claim
 // directory. Socket edge shares UI authority documents, never its slot claim.
 const fs=require('node:fs');
 for(const slot of plan.slots){const dir=path.join(base,slot.processInstanceId,'claims');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chownSync(path.dirname(dir),options.uid,options.gid);fs.chownSync(dir,options.uid,options.gid);}
 if(options.lifecycleOperator){fs.mkdirSync(path.join(base,'lifecycle-operator'),{mode:0o700});fs.chownSync(path.join(base,'lifecycle-operator'),options.uid,options.gid);writePrivate(path.join(base,'ledger.json'),require('./lifecycle-operator').ledger(plan),own,{compact:true});}
 return plan;
}
module.exports={prepare};
