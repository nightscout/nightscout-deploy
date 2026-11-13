'use strict';
const R=require('../realtime-recovery-roster'),B=require('../connection-budget');
const placement=require('../../../lib/realtime-placement'),ipc=require('../../../lib/server/internal-api/listener-config');
function fixture(){
 const source={coreCommit:'a'.repeat(40),deployCommit:'b'.repeat(40)};
 const expected={source,project:'synthetic-rt',workingDirectory:'/private/synthetic',imageId:'sha256:'+'c'.repeat(64)};
 const templates=['a','b','c'].map((worker,i)=>({worker,service:'realtime-'+worker,participantId:'rt-'+worker,address:{socket:'/private/rt-'+worker+'.sock'},consumerOrigin:'http://127.0.0.1:'+(19001+i),configSha256:'d'.repeat(64),environmentSha256:'e'.repeat(64)}));
 const participants=[...['api','evaluator','tenant-admin'].map((role,i)=>({id:role,roles:[role],namespaces:['synthetic'],endpoint:{socketPath:'/private/'+role+'.sock',maxBytes:4096,timeoutMs:1000}})),...templates.map(t=>({id:t.participantId,worker:t.worker,roles:['realtime'],namespaces:['synthetic'],endpoint:{socketPath:t.address.socket,maxBytes:4096,timeoutMs:1000}}))];
 const body={version:2,source,workerDatabase:{database:'synthetic',databaseOid:'123'},slots:templates.map(t=>({processInstanceId:t.service,roles:['realtime'],capabilities:{'nightscout-realtime-owner':{kind:'pool',poolMax:1,maxInstances:1}}}))};
 const plan={...body,sha256:B.hash(body)},internal=ipc.observer({});
 const prepared=R.prepare({plan,expected,templates,participants,internal});
 const map={version:2,rule:placement.RULE,shardCount:2,generation:1,owners:['a','a'],workers:templates.slice(0,2).map((t,i)=>({id:t.worker,incarnation:(i?'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),address:t.address,consumerOrigin:t.consumerOrigin}))};
 const platform=map.workers.map((w,i)=>({worker:w.id,assignmentIncarnation:w.incarnation,inspection:'RUNNING',noFutureDispatch:false,container:{...expected,service:templates[i].service,cid:(i?'2':'1').repeat(64),startedAt:'synthetic-birth-'+i,running:true}}));
 return{plan,expected,templates,participants,internal,prepared,map,platform};
}
module.exports=fixture;
