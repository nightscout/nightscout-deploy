#!/usr/bin/env node
'use strict';
// Explicit host operator action. Never imported by a serving role; never starts a process.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process'),{isDeepStrictEqual:equal}=require('node:util');
const fail=code=>Object.assign(Error(code),{code});
const need=(value,code)=>{if(!value)throw fail(code);};
const NAME=/^[a-z][a-z0-9_]{0,62}$/,SHA=/^[a-f0-9]{64}$/,IMAGE=/^sha256:[a-f0-9]{64}$/;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function read(file){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const stat=fs.fstatSync(fd);need(stat.isFile()&&stat.size<=2097152,'PGSTREAM_REBOOTSTRAP_FILE');return fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}}
function plan(value){
 need(value?.version===1&&['create-missing','replace-lost'].includes(value.action),'PGSTREAM_REBOOTSTRAP_PLAN');
 need(/^[a-z][a-z0-9-]{0,62}$/.test(value.project)&&IMAGE.test(value.imageId)&&IMAGE.test(value.postgresImageId),'PGSTREAM_REBOOTSTRAP_IDENTITY');
 need(['coreCommit','deployCommit'].every(key=>/^[a-f0-9]{40}$/.test(value.source?.[key])),'PGSTREAM_REBOOTSTRAP_SOURCE');
 need(NAME.test(value.database?.name)&&/^[1-9][0-9]*$/.test(value.database.oid)&&/^[0-9]+$/.test(value.database.systemIdentifier)&&typeof value.database.postmasterStartedAt==='string','PGSTREAM_REBOOTSTRAP_DATABASE');
 need(NAME.test(value.slot)&&NAME.test(value.operatorRole),'PGSTREAM_REBOOTSTRAP_SLOT');
 need(['deploymentDirectory','stateDirectory','evaluatorConfig','receiptFile'].every(key=>path.isAbsolute(value[key]||''))&&Array.isArray(value.composeFiles)&&value.composeFiles.length>0&&value.composeFiles.every(file=>path.isAbsolute(file)),'PGSTREAM_REBOOTSTRAP_PATH');
 need(Array.isArray(value.containers)&&value.containers.length>2&&value.containers.length<=128&&new Set(value.containers.map(row=>row.cid)).size===value.containers.length,'PGSTREAM_REBOOTSTRAP_COHORT');
 for(const row of value.containers)need(SHA.test(row.cid)&&IMAGE.test(row.imageId)&&typeof row.service==='string'&&typeof row.startedAt==='string'&&SHA.test(row.configHash),'PGSTREAM_REBOOTSTRAP_CONTAINER');
 if(value.environmentFile!==undefined)need(path.isAbsolute(value.environmentFile),'PGSTREAM_REBOOTSTRAP_PATH');
 for(const row of value.containers){const lineage=row.composeFiles||value.composeFiles;need(Array.isArray(lineage)&&lineage.length>0&&lineage.length<=value.composeFiles.length&&lineage.every((file,index)=>file===value.composeFiles[index]),'PGSTREAM_REBOOTSTRAP_COMPOSE_LINEAGE');}
 return value;
}
function platform(){const env=Object.fromEntries(['PATH','HOME','LANG','TZ'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));return (args,input)=>{try{return execFileSync('docker',args,{encoding:'utf8',input,env,timeout:30000,maxBuffer:4194304,stdio:['pipe','pipe','pipe']});}catch{throw fail('PGSTREAM_REBOOTSTRAP_PLATFORM_REFUSED');}};}
function normalized(rows){return rows.map(row=>JSON.stringify([row.url,row.schema_name,row.table_name,[...row.event_types].sort()])).sort();}
function validateSnapshot(p,rows,compose,image,hashes){
 need(image.Id===p.imageId&&image.Config?.Labels?.['org.opencontainers.image.revision']===p.source.coreCommit&&image.Config.Labels['org.nightscout.deploy.revision']===p.source.deployCommit,'PGSTREAM_REBOOTSTRAP_IMAGE');
 need(rows.length===p.containers.length,'PGSTREAM_REBOOTSTRAP_COHORT_CHANGED');
 const declarations=compose.services,known=new Map(p.containers.map(row=>[row.cid,row]));let postgres,evaluator;
 for(const row of rows){
  const expected=known.get(row.Id),labels=row.Config?.Labels||{},service=labels['com.docker.compose.service'];
  need(expected&&expected.service===service&&labels['com.docker.compose.project']===p.project&&labels['com.docker.compose.project.working_dir']===p.deploymentDirectory&&labels['com.docker.compose.config-hash']===expected.configHash&&row.Image===expected.imageId&&row.State.StartedAt===expected.startedAt,'PGSTREAM_REBOOTSTRAP_CONTAINER_CHANGED');
  need(declarations[service]&&hashes[service]===expected.configHash&&labels['com.docker.compose.project.config_files']===(expected.composeFiles||p.composeFiles).join(','),'PGSTREAM_REBOOTSTRAP_COMPOSE_CHANGED');
  if(service==='postgres'){need(!postgres&&row.Image===p.postgresImageId&&row.State.Running&&!row.State.Paused,'PGSTREAM_REBOOTSTRAP_POSTGRES');postgres=row;continue;}
  if(service==='vault'){need(row.State.Running&&!row.State.Paused,'PGSTREAM_REBOOTSTRAP_VAULT');continue;}
  // Every non-infrastructure container, including one-shot operators, is excluded.
  need(row.State.Running===false&&row.State.Pid===0&&row.State.Paused===false&&['exited','created','dead'].includes(row.State.Status),'PGSTREAM_REBOOTSTRAP_PROCESS_ALIVE');
  need(row.HostConfig?.RestartPolicy?.Name==='no','PGSTREAM_REBOOTSTRAP_AUTORESTART');
  need(service==='nginx'?/^(?:sha256:|[^@]+@sha256:)[a-f0-9]{64}$/.test(declarations[service].image):row.Image===p.imageId&&declarations[service].image===p.imageId,'PGSTREAM_REBOOTSTRAP_APPLICATION_IMAGE');
  for(const mount of row.Mounts||[])need(!mount.Destination.startsWith('/opt/app')&&mount.Destination!=='/usr/local/bin/pgstream','PGSTREAM_REBOOTSTRAP_SOURCE_MOUNT');
  if(service==='evaluator'){need(!evaluator,'PGSTREAM_REBOOTSTRAP_EVALUATOR');evaluator=row;}
 }
 need(postgres&&evaluator,'PGSTREAM_REBOOTSTRAP_REQUIRED_ROLES');
 need((evaluator.Mounts||[]).some(mount=>mount.Source===path.dirname(p.evaluatorConfig)&&mount.Destination==='/run/ns-config'&&mount.RW===false),'PGSTREAM_REBOOTSTRAP_CONFIG_MOUNT');
 return {postgres,evaluator};
}
function sqlInspection(p,c){
 const role=c.pgstream.streamRole,slot=p.slot;need(NAME.test(role)&&Object.values(c.postgres.namespaces).every(value=>NAME.test(value)),'PGSTREAM_REBOOTSTRAP_CONFIG');
 return `SELECT json_build_object('database',current_database(),'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'postmasterStartedAt',pg_postmaster_start_time()::text,
 'otherClients',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type IN ('client backend','walsender')),
 'role',(SELECT json_build_object('replication',rolreplication,'super',rolsuper,'bypass',rolbypassrls,'nonowner',NOT pg_has_role(oid,(SELECT datdba FROM pg_database WHERE datname=current_database()),'MEMBER') AND NOT pg_has_role(oid,(SELECT nspowner FROM pg_namespace WHERE nspname='pgstream'),'MEMBER'),
 'grants',has_schema_privilege(oid,'pgstream','USAGE') AND has_schema_privilege(oid,'pgstream','CREATE') AND has_table_privilege(oid,'pgstream.webhook_subscriptions','SELECT') AND NOT has_table_privilege(oid,'pgstream.webhook_subscriptions','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) FROM pg_roles WHERE rolname='${role}'),
 'slot',(SELECT json_build_object('name',slot_name,'database',database,'plugin',plugin,'active',active,'status',wal_status,'restart',restart_lsn::text) FROM pg_replication_slots WHERE slot_name='${slot}'),
 'subscriptions',(SELECT coalesce(json_agg(json_build_object('url',url,'schema_name',schema_name,'table_name',table_name,'event_types',event_types)),'[]') FROM pgstream.webhook_subscriptions));`;
}
function validateDatabase(p,c,row,routes){
 need(row.database===p.database.name&&row.databaseOid===p.database.oid&&row.systemIdentifier===p.database.systemIdentifier&&row.postmasterStartedAt===p.database.postmasterStartedAt,'PGSTREAM_REBOOTSTRAP_BACKEND_CHANGED');
 need(row.otherClients===0,'PGSTREAM_REBOOTSTRAP_OLD_BACKEND_PRESENT');
 need(row.role?.replication===true&&row.role.super===false&&row.role.bypass===false&&row.role.nonowner===true&&row.role.grants===true,'PGSTREAM_REBOOTSTRAP_RUNTIME_GRANTS');
 const expected=routes.map(route=>({url:'http://127.0.0.1:'+c.pgstream.receiverPort+'/pgstream',schema_name:route.schema,table_name:route.table,event_types:['D','I','U']}));expected.push({url:expected[0].url,schema_name:'',table_name:'',event_types:['M']});
 need(equal(normalized(row.subscriptions),normalized(expected)),'PGSTREAM_REBOOTSTRAP_SUBSCRIPTIONS');
 if(p.action==='create-missing')need(row.slot===null,'PGSTREAM_REBOOTSTRAP_SLOT_NOT_MISSING');
 else need(row.slot&&row.slot.name===p.slot&&row.slot.database===p.database.name&&row.slot.plugin==='wal2json'&&row.slot.active===false&&(row.slot.status==='lost'||row.slot.restart===null),'PGSTREAM_REBOOTSTRAP_SLOT_NOT_LOST');
}
function slotSQL(p){
 const identity=`current_database()='${p.database.name}' AND (SELECT oid::text FROM pg_database WHERE datname=current_database())='${p.database.oid}' AND (SELECT system_identifier::text FROM pg_control_system())='${p.database.systemIdentifier}'`;
 const target=p.action==='create-missing'?`NOT EXISTS(SELECT 1 FROM pg_replication_slots WHERE slot_name='${p.slot}')`:`EXISTS(SELECT 1 FROM pg_replication_slots WHERE slot_name='${p.slot}' AND database=current_database() AND plugin='wal2json' AND NOT active AND (wal_status='lost' OR restart_lsn IS NULL))`;
 return `SELECT pg_try_advisory_lock(hashtext('nightscout-pgstream-rebootstrap'),hashtext(current_database()||'${p.slot}')) AND ${identity} AND NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type IN ('client backend','walsender')) AND ${target} AS admitted\n\\gset\n\\if :admitted\n${p.action==='replace-lost'?`SELECT pg_drop_replication_slot('${p.slot}');\n`:''}SELECT row_to_json(created) FROM pg_create_logical_replication_slot('${p.slot}','wal2json') AS created;\n\\else\n\\quit 3\n\\endif\n`;
}
async function run(p,{docker=platform(),routes}={}){
 plan(p);const envFile=p.environmentFile||path.join(p.deploymentDirectory,'.env'),env=Object.fromEntries(read(envFile).trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
 need(env.NS_DEMO_PROJECT===p.project&&env.NS_DEMO_STATE===p.stateDirectory&&env.NS_SOURCE_COMMIT===p.source.coreCommit&&env.NS_PGSTREAM==='1','PGSTREAM_REBOOTSTRAP_PREPARATION');
 const complete=JSON.parse(read(path.join(p.stateDirectory,'bootstrap/complete.json')));need(complete.sourceCommit===p.source.coreCommit&&complete.deployCommit===p.source.deployCommit,'PGSTREAM_REBOOTSTRAP_PREPARATION_SOURCE');
 need(path.dirname(p.evaluatorConfig)===path.join(p.stateDirectory,'evaluator'),'PGSTREAM_REBOOTSTRAP_CONFIG_PATH');const c=JSON.parse(read(p.evaluatorConfig));need(c.pgstream?.slot===p.slot&&c.postgres&&SHA.test(p.evaluatorConfigSha256)&&hash(read(p.evaluatorConfig))===p.evaluatorConfigSha256,'PGSTREAM_REBOOTSTRAP_CONFIG');
 routes=routes||require('../../lib/pgstream/evaluator').routes({...c,namespaces:c.postgres.namespaces});
 const wireFile=path.join(path.dirname(p.evaluatorConfig),'pgstream.yaml'),wireText=read(wireFile);need(SHA.test(p.wireConfigSha256)&&hash(wireText)===p.wireConfigSha256,'PGSTREAM_REBOOTSTRAP_WIRE_CONFIG');
 const wire=JSON.parse(wireText),source=wire.source?.postgres,target=wire.target?.webhooks;
 need(source?.mode==='replication'&&source.replication?.replication_slot===p.slot&&new URL(source.url).username===c.pgstream.streamRole&&decodeURIComponent(new URL(source.url).pathname)==='/'+p.database.name&&source.replication.plugin.add_tables.split(',').sort().join(',')===routes.map(row=>row.schema+'.'+row.table).sort().join(',')&&target?.notifier?.strict_mode===true&&target.subscriptions?.store?.cache?.enabled!==true,'PGSTREAM_REBOOTSTRAP_WIRE_CONFIG');
 const composeArgs=['compose','--project-name',p.project,'--project-directory',p.deploymentDirectory,'--env-file',envFile,...p.composeFiles.flatMap(file=>['-f',file])];
 const snapshot=()=>{const compose=JSON.parse(docker([...composeArgs,'config','--format','json']));const ids=docker(['ps','-aq','--filter','label=com.docker.compose.project='+p.project]).trim().split(/\s+/).filter(Boolean);need(ids.length>0,'PGSTREAM_REBOOTSTRAP_NO_CONTAINERS');const rows=JSON.parse(docker(['inspect',...ids])),hashes=Object.fromEntries(docker([...composeArgs,'config','--hash','*']).trim().split('\n').map(line=>line.trim().split(/\s+/)));return validateSnapshot(p,rows,compose,JSON.parse(docker(['image','inspect',p.imageId]))[0],hashes);};
 let current=snapshot();const query=sql=>docker(['exec','-i',current.postgres.Id,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',p.operatorRole,'-d',p.database.name],sql);
 const inspect=()=>{const row=JSON.parse(query(sqlInspection(p,c)));validateDatabase(p,c,row,routes);return row;};
 const before=inspect();const receipt={version:1,operation:'pgstream-rebootstrap',state:'INSPECTED_STOPPED',source:p.source,slot:p.slot,action:p.action,receiptFile:p.receiptFile,evaluatorConfigSha256:p.evaluatorConfigSha256,wireConfigSha256:p.wireConfigSha256,imageId:p.imageId,project:p.project,database:p.database,containers:p.containers,helperSha256:hash(read(__filename)),next:'Keep all effect-serving roles stopped. Explicit evaluator-only restart establishes stream coverage, then existing reconciliation/pending/due recovery. Independently verify current physical clocks/output and due progress before reopening effects.'};
 fs.writeFileSync(p.receiptFile,JSON.stringify(receipt)+'\n',{mode:0o600,flag:'wx'});
 try{
  current=snapshot();inspect();receipt.state='SLOT_OPERATION_STARTED';fs.writeFileSync(p.receiptFile,JSON.stringify(receipt)+'\n',{mode:0o600});
  query(slotSQL(p));current=snapshot();const after=JSON.parse(query(sqlInspection(p,c)));
  need(after.database===before.database&&after.databaseOid===before.databaseOid&&after.systemIdentifier===before.systemIdentifier&&after.postmasterStartedAt===before.postmasterStartedAt&&after.otherClients===0,'PGSTREAM_REBOOTSTRAP_BACKEND_CHANGED');
  need(after.slot?.database===p.database.name&&after.slot.plugin==='wal2json'&&after.slot.active===false&&after.slot.restart!==null&&after.slot.status!=='lost','PGSTREAM_REBOOTSTRAP_NEW_SLOT_INVALID');
  need(equal(after.role,before.role)&&equal(normalized(after.subscriptions),normalized(before.subscriptions)),'PGSTREAM_REBOOTSTRAP_METADATA_CHANGED');receipt.state='SLOT_RECREATED_EFFECTS_STOPPED';
 }catch(error){receipt.state='REFUSED_KEEP_STOPPED';receipt.error=/^PGSTREAM_REBOOTSTRAP_[A-Z_]+$/.test(error.code||'')?error.code:'PGSTREAM_REBOOTSTRAP_REFUSED';throw fail(receipt.error);}
 finally{fs.writeFileSync(p.receiptFile,JSON.stringify(receipt)+'\n',{mode:0o600});}
 return receipt;
}
if(require.main===module){(async()=>{need(process.argv.length===3,'PGSTREAM_REBOOTSTRAP_USAGE');const result=await run(JSON.parse(read(process.argv[2])));process.stdout.write(JSON.stringify({operation:result.operation,state:result.state,receiptFile:result.receiptFile})+'\n');})().catch(error=>{process.stderr.write((/^PGSTREAM_REBOOTSTRAP_[A-Z_]+$/.test(error.code||'')?error.code:'PGSTREAM_REBOOTSTRAP_REFUSED')+'\n');process.exitCode=1;});}
module.exports={run,plan,validateSnapshot,validateDatabase,slotSQL,sqlInspection};
