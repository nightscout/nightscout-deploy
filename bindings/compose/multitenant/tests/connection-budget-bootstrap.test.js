'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const F=require('../connection-budget-files'),P=require('../connection-budget-profile'),prepare=require('../connection-budget-bootstrap').prepare;
const source={coreCommit:'d0036890d0623ae79f14bfa71e7226c0fa122a29',deployCommit:'b'.repeat(40)};
const {input}=require('./connection-budget-source-fixture');
test('bootstrap binds observed target once, exact settings and selected source environment before worker tickets',()=>{
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'ns-budget-bootstrap-'));fs.chmodSync(output,0o700);
 try{const docs=P.sourceDocuments(),resolved=P.resolve(input(docs),{source}),file=path.join(output,'profile.json');F.write(file,resolved.profile);
 const observed={systemIdentifier:'123',postmasterStartedAt:'actual-epoch',serverMaximum:resolved.requiredMaximum,superuserReserved:3,otherReserved:0};
 const options={output,uid:process.getuid(),gid:process.getgid(),sourceCommit:source.coreCommit,deployCommit:source.deployCommit,connectionBudgetProfile:file,connectionBudgetObserved:observed};
 const writePrivate=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(value),{flag:'wx',mode:0o600});};
 assert.throws(()=>prepare({options:{...options,connectionBudgetObserved:{...observed,serverMaximum:observed.serverMaximum+1}},docs,writePrivate}),/ACTUAL_SETTINGS_CHANGED/);assert(!fs.existsSync(path.join(output,'connection-budget/plan.json')));
 const plan=prepare({options,docs,writePrivate});assert.equal(plan.resource.systemIdentifier,'123');assert.equal(plan.resource.postmasterStartedAt,'actual-epoch');for(const env of [...Object.values(docs.environments),docs.admin.environment,docs.feed.environment,docs.uiEnvironment])assert.equal(env.NS_SOURCE_COMMIT,source.coreCommit);
 const view=path.join(output,'connection-budget','plan-view','plan.json'),canonical=path.join(output,'connection-budget','plan.json');
 assert.deepEqual(F.read(view),plan);assert.equal(fs.statSync(path.dirname(view)).mode&0o777,0o700);assert.equal(fs.statSync(view).mode&0o777,0o600);assert.equal(fs.statSync(view).nlink,1);assert.notEqual(fs.statSync(view).ino,fs.statSync(canonical).ino);assert.deepEqual(fs.readdirSync(path.dirname(view)),['plan.json']);
 for(const slot of plan.slots){assert(fs.statSync(path.join(output,'connection-budget',slot.processInstanceId,'claims')).isDirectory());assert(!fs.existsSync(path.join(output,'connection-budget',slot.processInstanceId,'ticket.json')));}
 }finally{fs.rmSync(output,{recursive:true});}
});
