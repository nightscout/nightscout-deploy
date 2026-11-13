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
 const plan=B.compile(profile,docs,{source:{coreCommit:options.sourceCommit,deployCommit:options.deployCommit},poolConfig:require('../../lib/server/serve/pool-config')});
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
 return plan;
}
module.exports={prepare};
