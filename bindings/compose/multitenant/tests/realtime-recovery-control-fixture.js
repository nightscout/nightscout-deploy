'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const F=require('../connection-budget-files'),C=require('../control-recovery'),B=require('../connection-budget'),R=require('../realtime-recovery-roster'),J=require('../realtime-recovery-journal'),fixture=require('./realtime-recovery-action-fixture');
function lab(){
 const f=fixture(),root=fs.mkdtempSync(path.join(os.tmpdir(),'rt-action-journal-'));fs.chmodSync(root,0o700);
 f.plan.resource.pgResourceId='synthetic-pg';f.plan.resource.aliases=['pg:5432'];f.plan.lifecycleOperator={version:2};f.plan.resource.serverMaximum=20;f.plan.resource.reserved={superuser:3,other:0};f.plan.resource.allowances={controlRecovery:2,unmanaged:0,oldNewRolloutOverlap:3};for(const slot of f.plan.slots){slot.maximumOutstandingGenerations=2;slot.declaredMaximum=1;slot.startupConcurrency=1;slot.directGroups={};slot.cold={activeLimit:1,pendingLimit:1,minDelayMs:0,maxDelayMs:0};for(const c of Object.values(slot.capabilities))c.metadata={requestedMaximum:1,source:'synthetic-owner',configurationSource:'explicit-profile'};}
 f.plan.controlRecovery={version:1,classes:Object.fromEntries(C.CLASSES.map((c,i)=>[c,{principal:{role:'synthetic_'+i,roleOid:String(31+i),database:f.plan.workerDatabase.database,databaseOid:f.plan.workerDatabase.databaseOid}}]))};
 const{sha256,...body}=f.plan;f.plan.sha256=B.hash(body);f.prepared=R.prepare(f);const book=C.ledger(f.plan);
 Object.assign(f.context,{plan:f.plan,prepared:f.prepared});Object.assign(f.value,{planSha256:f.plan.sha256,inventorySha256:f.prepared.sha256});
 const observation={pgResourceId:'synthetic-pg',systemIdentifier:'123',postmasterStartedAt:'synthetic-epoch',serverMaximum:20,superuserReserved:3,otherReserved:0,unmanagedClients:0,bootstrapClosed:true};
 for(const old of f.platform){const slot=old.container.service,ticket=B.generation(f.plan,book,slot,observation),container=structuredClone(old.container);delete container.running;B.recordStarted(f.plan,book,slot,ticket.incarnation,container);fs.mkdirSync(path.join(root,slot),{mode:0o700});F.write(path.join(root,slot,'ticket.json'),ticket);}
 F.write(path.join(root,'plan.json'),f.plan);F.write(path.join(root,'ledger.json'),book);
 return{...f,root,book,close(){fs.rmSync(root,{recursive:true,force:true});}};
}
function selected(f,api=J){const fresh=api.allocate(f.fd,f.plan,f.book,f.context.intent);Object.assign(f.value,{leaseIncarnation:fresh.row.incarnation,nonce:fresh.row.nonce,intentSha256:fresh.row.intentSha256});return fresh;}

module.exports={lab,selected};
