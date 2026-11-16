'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const recovery=require('./pgstream-rebootstrap');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const routes=[['clock','tenant_write_clock'],['settings','tenant_settings'],['policy','tenant_operator_policy'],['control','tenant_activity'],['control','tenant_lifecycle_windows'],['clock','nightscout_heartbeat']].map(([schema,table])=>({schema,table}));
function fixture(action='create-missing'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pgstream-rebootstrap-')),state=path.join(root,'state'),deployment=path.join(root,'deployment');fs.mkdirSync(deployment);fs.mkdirSync(path.join(state,'bootstrap'),{recursive:true});fs.mkdirSync(path.join(state,'evaluator'));fs.mkdirSync(path.join(state,'pgstream'));
 const config={consumer:'synthetic',postgres:{namespaces:{clock:'clock',checkpoint:'checkpoint'}},trustedWorker:{settings:'settings',operatorPolicy:'policy',activity:'control'},pgstream:{slot:'selected_slot',streamRole:'stream_reader',receiver:{url:'http://synthetic-intake:19913/',trust:'network',bindHost:'0.0.0.0',maxBytes:16777216,timeoutMs:5000}}};
 const source={coreCommit:'a'.repeat(40),deployCommit:'b'.repeat(40)},imageId='sha256:'+'c'.repeat(64),postgresImageId='sha256:'+'d'.repeat(64),database={name:'synthetic',oid:'100',systemIdentifier:'123456',postmasterStartedAt:'2026-11-14 00:00:00+00'};
 const p={version:1,action,project:'synthetic-rebootstrap',source,imageId,postgresImageId,database,slot:config.pgstream.slot,operatorRole:'postgres',deploymentDirectory:deployment,stateDirectory:state,evaluatorConfig:path.join(state,'evaluator/config.json'),receiptFile:path.join(root,'receipt.json'),composeFiles:[path.join(deployment,'compose.yaml')]};
 fs.writeFileSync(path.join(deployment,'.env'),Object.entries({NS_DEMO_PROJECT:p.project,NS_DEMO_STATE:state,NS_SOURCE_COMMIT:source.coreCommit,NS_PGSTREAM:'1'}).map(([key,value])=>key+'='+value).join('\n'));
 fs.writeFileSync(path.join(state,'bootstrap/complete.json'),JSON.stringify({sourceCommit:source.coreCommit,deployCommit:source.deployCommit}));fs.writeFileSync(p.evaluatorConfig,JSON.stringify(config));p.evaluatorConfigSha256=digest(fs.readFileSync(p.evaluatorConfig));
 const sourceURL=new URL('postgres://postgres/synthetic');sourceURL.username=config.pgstream.streamRole;sourceURL.password=crypto.randomBytes(12).toString('hex');
 const wire={source:{postgres:{url:sourceURL.href,mode:'replication',replication:{replication_slot:p.slot,plugin:{add_tables:routes.map(row=>row.schema+'.'+row.table).join(',')}}}},target:{webhooks:{notifier:{strict_mode:true},subscriptions:{store:{cache:{enabled:false}}}}}};fs.writeFileSync(path.join(state,'pgstream/pgstream.yaml'),JSON.stringify(wire));p.wireConfigSha256=digest(JSON.stringify(wire));
 const services=['postgres','vault','evaluator','realtime','api','admin','nginx','pgstream'],rows=services.map((service,index)=>({Id:String(index+1).repeat(64),Image:service==='postgres'?postgresImageId:imageId,Config:{Labels:{'com.docker.compose.project':p.project,'com.docker.compose.service':service,'com.docker.compose.project.working_dir':deployment,'com.docker.compose.project.config_files':p.composeFiles.join(','),'com.docker.compose.config-hash':String(index+1).repeat(64)}},State:{Running:['postgres','vault'].includes(service),Paused:false,Pid:['postgres','vault'].includes(service)?200+index:0,Status:['postgres','vault'].includes(service)?'running':'exited',StartedAt:'2026-11-14T00:00:00Z'},HostConfig:{RestartPolicy:{Name:'no'}},Mounts:service==='evaluator'?[{Source:path.dirname(p.evaluatorConfig),Destination:'/run/ns-config',RW:false}]:service==='pgstream'?[{Source:path.join(state,'pgstream'),Destination:'/run/ns-stream',RW:false}]:[]}));
 p.containers=rows.map(row=>({cid:row.Id,imageId:row.Image,service:row.Config.Labels['com.docker.compose.service'],startedAt:row.State.StartedAt,configHash:row.Config.Labels['com.docker.compose.config-hash']}));
 const subscriptions=routes.map(row=>({url:'http://synthetic-intake:19913/pgstream',schema_name:row.schema,table_name:row.table,event_types:['D','I','U']}));subscriptions.push({url:subscriptions[0].url,schema_name:'',table_name:'',event_types:['M']});
 const row={database:database.name,databaseOid:database.oid,systemIdentifier:database.systemIdentifier,postmasterStartedAt:database.postmasterStartedAt,otherClients:0,role:{replication:true,super:false,bypass:false,nonowner:true,grants:true},slot:action==='create-missing'?null:{name:p.slot,database:database.name,plugin:'wal2json',active:false,status:'lost',restart:null},subscriptions};
 fs.writeFileSync(p.composeFiles[0],'{}');p.approvedHistoricalComposeFiles=[{path:p.composeFiles[0],sha256:digest('{}')}];
 const data={hashes:Object.fromEntries(p.containers.map(row=>[row.service,row.configHash])),rows,compose:{services:Object.fromEntries(services.map(service=>[service,{image:service==='postgres'?postgresImageId:imageId}]))},image:[{Id:imageId,Config:{Labels:{'org.opencontainers.image.revision':source.coreCommit,'org.nightscout.deploy.revision':source.deployCommit}}}],row,mutations:0,commands:[]};
 const manifest=path.join(root,'plan.json');fs.writeFileSync(manifest,JSON.stringify(p));return {root,p,data,manifest,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
function fake(args,input){
 const fs=require('node:fs');const file=process.env.REBOOTSTRAP_TEST_PLATFORM;const d=JSON.parse(fs.readFileSync(file));d.commands.push(args);
 let output;
 if(args[0]==='compose'){const files=args.flatMap((arg,index)=>arg==='-f'?[args[index+1]]:[]),hashes=d.hashesByFiles?.[JSON.stringify(files)]||d.hashes;output=args.includes('--hash')?Object.entries(hashes).map(([service,hash])=>service+' '+hash).join('\n'):JSON.stringify(d.compose);}
 else if(args[0]==='ps')output=d.rows.map(row=>row.Id).join('\n');
 else if(args[0]==='inspect')output=JSON.stringify(d.rows);
 else if(args[0]==='image')output=JSON.stringify(d.image);
 else if(args[0]==='exec'){
  if(input.includes('pg_create_logical_replication_slot')){d.mutations++;d.slotSQL=input;d.row.slot={name:'selected_slot',database:d.row.database,plugin:'wal2json',active:false,status:'reserved',restart:'0/123'};output='{}';}
  else output=JSON.stringify(d.row);
 }else throw Error('Unexpected platform command');fs.writeFileSync(file,JSON.stringify(d));return output;
}
function cli(f){
 const bin=path.join(f.root,'bin');fs.mkdirSync(bin);const platform=path.join(f.root,'platform.json');fs.writeFileSync(platform,JSON.stringify(f.data));
 fs.writeFileSync(path.join(bin,'docker'),'#!/usr/bin/env node\nconst args=process.argv.slice(2),input=require("node:fs").readFileSync(0,"utf8");process.stdout.write(('+fake.toString()+')(args,input));\n',{mode:0o700});
 // The production CLI sanitizes Docker's environment. The fake uses only its own fixed adjacent file.
 const code=fs.readFileSync(path.join(bin,'docker'),'utf8').replace('process.env.REBOOTSTRAP_TEST_PLATFORM',JSON.stringify(platform));fs.writeFileSync(path.join(bin,'docker'),code,{mode:0o700});
 const q=spawnSync(process.execPath,[path.join(__dirname,'pgstream-rebootstrap.js'),f.manifest],{env:{PATH:bin+':'+process.env.PATH,HOME:process.env.HOME},encoding:'utf8'});return {q,data:JSON.parse(fs.readFileSync(platform))};
}
for(const action of ['create-missing','replace-lost'])test('callable host command '+action+' changes only exact slot and leaves all effects stopped',()=>{
 const f=fixture(action);try{const {q,data}=cli(f);assert.equal(q.status,0,q.stderr);assert.equal(data.mutations,1);assert.match(data.slotSQL,/pg_create_logical_replication_slot\('selected_slot','wal2json'\)/);assert.equal(/\b(?:UPDATE|INSERT|DELETE|CREATE TABLE|ALTER|GRANT|TRUNCATE)\b/.test(data.slotSQL),false);assert.equal(data.commands.some(args=>['start','stop','kill','run','restart'].includes(args[0])||args.includes('up')),false);assert.equal(JSON.parse(fs.readFileSync(f.p.receiptFile)).state,'SLOT_RECREATED_EFFECTS_STOPPED');assert.match(data.slotSQL,/pg_try_advisory_lock/);}finally{f.cleanup();}
});
function mixedHistory(f){
 const frozen=f.p.composeFiles[0],old=path.join(f.p.deploymentDirectory,'observer01.json'),current=path.join(f.p.deploymentDirectory,'effects.json');fs.writeFileSync(old,'{}');fs.writeFileSync(current,'{}');f.p.composeFiles=[frozen,current];f.p.approvedHistoricalComposeFiles=[frozen,old,current].map(file=>({path:file,sha256:digest(fs.readFileSync(file))}));
 for(const row of f.data.rows){const service=row.Config.Labels['com.docker.compose.service'],lineage=['postgres','vault','api'].includes(service)?[frozen]:['evaluator','realtime','admin'].includes(service)?[frozen,current]:[frozen,old];row.Config.Labels['com.docker.compose.project.config_files']=lineage.join(',');f.p.containers.find(expected=>expected.cid===row.Id).composeFiles=lineage;}
 return {frozen,old,current};
}
test('callable host command accepts exact mixed non-prefix override history with matching historical and current hashes',()=>{
 const f=fixture();try{mixedHistory(f);f.p.environmentFile=path.join(f.root,'active-env');fs.renameSync(path.join(f.p.deploymentDirectory,'.env'),f.p.environmentFile);fs.writeFileSync(f.manifest,JSON.stringify(f.p));const {q,data}=cli(f);assert.equal(q.status,0,q.stderr);assert.equal(data.mutations,1);}finally{f.cleanup();}
});
for(const control of ['unknown-file','changed-approved-file','reordered-history','wrong-historical-effective-hash'])test('known historical lineage refuses '+control,()=>{
 const f=fixture();try{const files=mixedHistory(f);
  if(control==='unknown-file')f.p.containers[6].composeFiles=[files.frozen,path.join(f.root,'unknown.json')];
  if(control==='changed-approved-file')fs.writeFileSync(files.old,'{"changed":true}');
  if(control==='reordered-history')f.p.containers[6].composeFiles=[files.old,files.frozen];
  if(control==='wrong-historical-effective-hash')f.data.hashesByFiles={[JSON.stringify([files.frozen,files.old])]:{...f.data.hashes,nginx:'e'.repeat(64)}};
  fs.writeFileSync(f.manifest,JSON.stringify(f.p));const {q,data}=cli(f);assert.notEqual(q.status,0);assert.equal(q.stderr.trim(),{
   'unknown-file':'PGSTREAM_REBOOTSTRAP_COMPOSE_LINEAGE','changed-approved-file':'PGSTREAM_REBOOTSTRAP_APPROVED_FILE_CHANGED','reordered-history':'PGSTREAM_REBOOTSTRAP_COMPOSE_LINEAGE','wrong-historical-effective-hash':'PGSTREAM_REBOOTSTRAP_COMPOSE_CHANGED'
  }[control]);assert.equal(data.mutations,0);
 }finally{f.cleanup();}
});
test('restart policy must be explicitly disabled while stopped, with original policy retained for deliberate restart',()=>{
 const f=fixture();try{f.data.rows[2].HostConfig.RestartPolicy={Name:'no',MaximumRetryCount:0};f.p.containers[2].originalRestartPolicy={Name:'on-failure',MaximumRetryCount:3};fs.writeFileSync(f.manifest,JSON.stringify(f.p));const {q}=cli(f);assert.equal(q.status,0,q.stderr);assert.deepEqual(JSON.parse(fs.readFileSync(f.p.receiptFile)).containers[2].originalRestartPolicy,{Name:'on-failure',MaximumRetryCount:3});}finally{f.cleanup();}
});
const controls={
 'stream-autorestart-not-disabled':f=>{f.data.rows[7].HostConfig.RestartPolicy={Name:'unless-stopped'};},
 'stream-left-running':f=>{f.data.rows[7].State.Running=true;f.data.rows[7].State.Pid=99;f.data.rows[7].State.Status='running';},
 'stream-config-mount-missing':f=>{f.data.rows[7].Mounts=[];},
 'wire-exposed-to-evaluator':f=>{f.data.rows[2].Mounts.push({Source:path.join(f.p.stateDirectory,'pgstream'),Destination:'/run/ns-stream',RW:false});},
 'autorestart-not-disabled':f=>{f.data.rows[2].HostConfig.RestartPolicy={Name:'on-failure',MaximumRetryCount:3};},
 'unrecorded-compose-lineage':f=>{f.data.rows[2].Config.Labels['com.docker.compose.project.config_files']+=',/unrecorded/observer.json';},
 'stopped-but-PID-present':f=>{f.data.rows[2].State.Pid=99;},
 'live-but-paused':f=>{f.data.rows[2].State.Running=true;f.data.rows[2].State.Paused=true;f.data.rows[2].State.Pid=99;},
 'wrong-image':f=>{f.data.rows[2].Image='sha256:'+'e'.repeat(64);},
 'new-process-incarnation':f=>{f.data.rows[2].State.StartedAt='2026-11-14T01:00:00Z';},
 'unknown-project-process':f=>{f.data.rows.push({...structuredClone(f.data.rows[2]),Id:'f'.repeat(64)});},
 'changed-compose-hash':f=>{f.data.rows[2].Config.Labels['com.docker.compose.config-hash']='e'.repeat(64);},
 'changed-current-compose-declaration':f=>{f.data.hashes.evaluator='e'.repeat(64);},
 'active-old-backend':f=>{f.data.row.otherClients=1;},
 'runtime-owner-privilege':f=>{f.data.row.role.nonowner=false;},
 'changed-subscription':f=>{f.data.row.subscriptions.pop();},
 'wrong-physical-database':f=>{f.data.row.systemIdentifier='999';},
 'active-slot':f=>{f.data.row.slot.active=true;},
 'valid-slot':f=>{f.data.row.slot.status='reserved';f.data.row.slot.restart='0/123';},
 'wrong-plugin':f=>{f.data.row.slot.plugin='pgoutput';}
};
const refusedCodes={
 'stream-autorestart-not-disabled':'AUTORESTART','stream-left-running':'PROCESS_ALIVE','stream-config-mount-missing':'STREAM_CONFIG_MOUNT','wire-exposed-to-evaluator':'WIRE_EXPOSED_TO_EVALUATOR',
 'autorestart-not-disabled':'AUTORESTART','unrecorded-compose-lineage':'COMPOSE_CHANGED','stopped-but-PID-present':'PROCESS_ALIVE','live-but-paused':'PROCESS_ALIVE','wrong-image':'CONTAINER_CHANGED','new-process-incarnation':'CONTAINER_CHANGED','unknown-project-process':'COHORT_CHANGED','changed-compose-hash':'CONTAINER_CHANGED','changed-current-compose-declaration':'COMPOSE_CHANGED','active-old-backend':'OLD_BACKEND_PRESENT','runtime-owner-privilege':'RUNTIME_GRANTS','changed-subscription':'SUBSCRIPTIONS','wrong-physical-database':'BACKEND_CHANGED','active-slot':'SLOT_NOT_LOST','valid-slot':'SLOT_NOT_LOST','wrong-plugin':'SLOT_NOT_LOST'
};
for(const [name,breakIt] of Object.entries(controls))test('callable command refuses '+name+' before mutation',()=>{const f=fixture('replace-lost');try{breakIt(f);const {q,data}=cli(f);assert.notEqual(q.status,0);assert.equal(q.stderr.trim(),'PGSTREAM_REBOOTSTRAP_'+refusedCodes[name]);assert.equal(data.mutations,0);}finally{f.cleanup();}});
test('slot operation repeats no-client, backend, inactive/lost and operator exclusion guards at mutation boundary',()=>{const f=fixture('replace-lost');try{const sql=recovery.slotSQL(f.p);for(const guard of ['pg_try_advisory_lock','pg_stat_activity','system_identifier','NOT active',"plugin='wal2json'","wal_status='lost'",'\\quit 3'])assert.ok(sql.includes(guard),guard);}finally{f.cleanup();}});
