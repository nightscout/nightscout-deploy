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
 need(value?.version===1&&['create-missing','replace-lost','replace-revision'].includes(value.action),'PGSTREAM_REBOOTSTRAP_PLAN');
 if(value.action==='replace-revision')need(value.revision&&['planFile','upgradeRecord','coldManifest','startedRecord'].every(key=>path.isAbsolute(value.revision[key]||''))&&['planSha256','recordSha256','coldSha256','startedSha256'].every(key=>SHA.test(value.revision[key]||'')),'PGSTREAM_REBOOTSTRAP_REVISION_REQUIRED');
 need(/^[a-z][a-z0-9-]{0,62}$/.test(value.project)&&IMAGE.test(value.imageId)&&IMAGE.test(value.postgresImageId),'PGSTREAM_REBOOTSTRAP_IDENTITY');
 need(['coreCommit','deployCommit'].every(key=>/^[a-f0-9]{40}$/.test(value.source?.[key])),'PGSTREAM_REBOOTSTRAP_SOURCE');
 need(NAME.test(value.database?.name)&&/^[1-9][0-9]*$/.test(value.database.oid)&&/^[0-9]+$/.test(value.database.systemIdentifier)&&typeof value.database.postmasterStartedAt==='string','PGSTREAM_REBOOTSTRAP_DATABASE');
 need(NAME.test(value.slot)&&NAME.test(value.operatorRole),'PGSTREAM_REBOOTSTRAP_SLOT');
 need(['deploymentDirectory','stateDirectory','evaluatorConfig','receiptFile'].every(key=>path.isAbsolute(value[key]||''))&&Array.isArray(value.composeFiles)&&value.composeFiles.length>0&&value.composeFiles.every(file=>path.isAbsolute(file)),'PGSTREAM_REBOOTSTRAP_PATH');
 need(Array.isArray(value.containers)&&value.containers.length>2&&value.containers.length<=128&&new Set(value.containers.map(row=>row.cid)).size===value.containers.length,'PGSTREAM_REBOOTSTRAP_COHORT');
 for(const row of value.containers)need(SHA.test(row.cid)&&IMAGE.test(row.imageId)&&typeof row.service==='string'&&typeof row.startedAt==='string'&&SHA.test(row.configHash),'PGSTREAM_REBOOTSTRAP_CONTAINER');
 if(value.environmentFile!==undefined)need(path.isAbsolute(value.environmentFile),'PGSTREAM_REBOOTSTRAP_PATH');
 need(Array.isArray(value.approvedHistoricalComposeFiles)&&value.approvedHistoricalComposeFiles.length>0&&new Set(value.approvedHistoricalComposeFiles.map(row=>row.path)).size===value.approvedHistoricalComposeFiles.length&&value.approvedHistoricalComposeFiles.every(row=>path.isAbsolute(row.path||'')&&SHA.test(row.sha256)),'PGSTREAM_REBOOTSTRAP_APPROVED_FILES');
 const approved=value.approvedHistoricalComposeFiles.map(row=>row.path);
 for(const lineage of [value.composeFiles,...value.containers.map(row=>row.composeFiles||value.composeFiles)])need(Array.isArray(lineage)&&lineage.length>0&&lineage[0]===value.composeFiles[0]&&lineage.every((file,index)=>approved.includes(file)&&(index===0||approved.indexOf(lineage[index-1])<approved.indexOf(file))),'PGSTREAM_REBOOTSTRAP_COMPOSE_LINEAGE');
 return value;
}
function platform(){const env=Object.fromEntries(['PATH','HOME','LANG','TZ'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));return (args,input)=>{try{return execFileSync('docker',args,{encoding:'utf8',input,env,timeout:30000,maxBuffer:4194304,stdio:['pipe','pipe','pipe']});}catch{throw fail('PGSTREAM_REBOOTSTRAP_PLATFORM_REFUSED');}};}
function normalized(rows){return rows.map(row=>JSON.stringify([row.url,row.schema_name,row.table_name,[...row.event_types].sort()])).sort();}
function validateSnapshot(p,rows,compose,image,hashes,historicalHashes){
 need(image.Id===p.imageId&&image.Config?.Labels?.['org.opencontainers.image.revision']===p.source.coreCommit&&image.Config.Labels['org.nightscout.deploy.revision']===p.source.deployCommit,'PGSTREAM_REBOOTSTRAP_IMAGE');
 need(rows.length===p.containers.length,'PGSTREAM_REBOOTSTRAP_COHORT_CHANGED');
 const declarations=compose.services,known=new Map(p.containers.map(row=>[row.cid,row]));let postgres,evaluator,stream;
 for(const row of rows){
  const expected=known.get(row.Id),labels=row.Config?.Labels||{},service=labels['com.docker.compose.service'];
  need(expected&&expected.service===service&&labels['com.docker.compose.project']===p.project&&labels['com.docker.compose.project.working_dir']===p.deploymentDirectory&&labels['com.docker.compose.config-hash']===expected.configHash&&row.Image===expected.imageId&&row.State.StartedAt===expected.startedAt,'PGSTREAM_REBOOTSTRAP_CONTAINER_CHANGED');
  need(declarations[service]&&hashes[service]===expected.configHash&&historicalHashes[JSON.stringify(expected.composeFiles||p.composeFiles)]?.[service]===expected.configHash&&labels['com.docker.compose.project.config_files']===(expected.composeFiles||p.composeFiles).join(','),'PGSTREAM_REBOOTSTRAP_COMPOSE_CHANGED');
  if(service==='postgres'){need(!postgres&&row.Image===p.postgresImageId&&row.State.Running&&!row.State.Paused,'PGSTREAM_REBOOTSTRAP_POSTGRES');postgres=row;continue;}
  if(service==='vault'){need(row.State.Running&&!row.State.Paused,'PGSTREAM_REBOOTSTRAP_VAULT');continue;}
  // Every non-infrastructure container, including one-shot operators, is excluded.
  need(row.State.Running===false&&row.State.Pid===0&&row.State.Paused===false&&['exited','created','dead'].includes(row.State.Status),'PGSTREAM_REBOOTSTRAP_PROCESS_ALIVE');
  need(row.HostConfig?.RestartPolicy?.Name==='no','PGSTREAM_REBOOTSTRAP_AUTORESTART');
  need(service==='nginx'?/^(?:sha256:|[^@]+@sha256:)[a-f0-9]{64}$/.test(declarations[service].image):row.Image===p.imageId&&declarations[service].image===p.imageId,'PGSTREAM_REBOOTSTRAP_APPLICATION_IMAGE');
  for(const mount of row.Mounts||[])need(!mount.Destination.startsWith('/opt/app')&&mount.Destination!=='/usr/local/bin/pgstream','PGSTREAM_REBOOTSTRAP_SOURCE_MOUNT');
  if(service==='evaluator'){need(!evaluator,'PGSTREAM_REBOOTSTRAP_EVALUATOR');evaluator=row;}
  if(service==='pgstream'){need(!stream,'PGSTREAM_REBOOTSTRAP_STREAM');stream=row;}
 }
 need(postgres&&evaluator&&stream,'PGSTREAM_REBOOTSTRAP_REQUIRED_ROLES');
 need((evaluator.Mounts||[]).some(mount=>mount.Source===path.dirname(p.evaluatorConfig)&&mount.Destination==='/run/ns-config'&&mount.RW===false),'PGSTREAM_REBOOTSTRAP_CONFIG_MOUNT');
 need((stream.Mounts||[]).some(mount=>mount.Source===path.join(p.stateDirectory,'pgstream')&&mount.Destination==='/run/ns-stream'&&mount.RW===false),'PGSTREAM_REBOOTSTRAP_STREAM_CONFIG_MOUNT');
 need(!(evaluator.Mounts||[]).some(mount=>mount.Source===path.join(p.stateDirectory,'pgstream')),'PGSTREAM_REBOOTSTRAP_WIRE_EXPOSED_TO_EVALUATOR');
 return {postgres,evaluator,stream};
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
 const expected=routes.map(route=>({url:new URL('pgstream',c.pgstream.receiver.url).href,schema_name:route.schema,table_name:route.table,event_types:['D','I','U']}));expected.push({url:expected[0].url,schema_name:'',table_name:'',event_types:['B','C','M']});
 need(equal(normalized(row.subscriptions),normalized(expected)),'PGSTREAM_REBOOTSTRAP_SUBSCRIPTIONS');
 if(p.action==='create-missing')need(row.slot===null,'PGSTREAM_REBOOTSTRAP_SLOT_NOT_MISSING');
 else if(p.action==='replace-revision')need(row.slot&&row.slot.name===p.slot&&row.slot.database===p.database.name&&row.slot.plugin==='wal2json'&&row.slot.active===false&&row.slot.status!=='lost'&&row.slot.restart!==null,'PGSTREAM_REBOOTSTRAP_REVISION_SLOT');
 else need(row.slot&&row.slot.name===p.slot&&row.slot.database===p.database.name&&row.slot.plugin==='wal2json'&&row.slot.active===false&&(row.slot.status==='lost'||row.slot.restart===null),'PGSTREAM_REBOOTSTRAP_SLOT_NOT_LOST');
}
function slotSQL(p){
 const identity=`current_database()='${p.database.name}' AND (SELECT oid::text FROM pg_database WHERE datname=current_database())='${p.database.oid}' AND (SELECT system_identifier::text FROM pg_control_system())='${p.database.systemIdentifier}'`;
 const target=p.action==='create-missing'?`NOT EXISTS(SELECT 1 FROM pg_replication_slots WHERE slot_name='${p.slot}')`:`EXISTS(SELECT 1 FROM pg_replication_slots WHERE slot_name='${p.slot}' AND database=current_database() AND plugin='wal2json' AND NOT active AND ${p.action==='replace-revision'?"wal_status<>'lost' AND restart_lsn IS NOT NULL":"(wal_status='lost' OR restart_lsn IS NULL)"})`;
 return `SELECT pg_try_advisory_lock(hashtext('nightscout-pgstream-rebootstrap'),hashtext(current_database()||'${p.slot}')) AND ${identity} AND NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type IN ('client backend','walsender')) AND ${target} AS admitted\n\\gset\n\\if :admitted\n${p.action!=='create-missing'?`SELECT pg_drop_replication_slot('${p.slot}');\n`:''}SELECT row_to_json(created) FROM pg_create_logical_replication_slot('${p.slot}','wal2json') AS created;\n\\else\n\\quit 3\n\\endif\n`;
}
function ordinaryAdmission(root,libraryRoot=root){
 const config=require(path.join(root,'deploy/multitenant/config')),common=require(path.join(libraryRoot,'lib/tenant-operations/common')),ops=require(path.join(libraryRoot,'lib/tenant-operations/catalogues'));
 const found=ops.discoverCatalogues(root),layout=config.layout(),namespaces={},selection={},extensions=[];
 const aliases={control:'lifecycle',rt_checkpoint:'checkpoint',eval_checkpoint:'evaluator_checkpoint',alarm:'alarm_suppression',outbox:'notification_outbox',display_settings:'tenant_settings'};
 for(const [key,candidate]of Object.entries(config.catalogues())){
  need(key!=='pool','PGSTREAM_REBOOTSTRAP_REVISION_PROFILE');if(key==='registry')continue;
  const kind=aliases[key]||key,matches=found.filter(row=>common.canonical(row.candidate)===common.canonical(candidate));need(matches.length===1,'PGSTREAM_REBOOTSTRAP_REVISION_CATALOGUE');namespaces[kind]=layout.namespaces[key];
  if(['alarm','outbox'].includes(key))extensions.push({kind,candidatePath:matches[0].file,candidateDigest:common.sha256(common.canonical(candidate)),tables:ops.createdTables(candidate)});else if(key!=='control')selection[kind]=matches[0].file;
 }
 return {root,namespaces,selection,extensions,instances:[{kind:'evaluator_checkpoint',of:'checkpoint'}]};
}
function revisionRecord(p){
 const r=p.revision,load=(file,expected)=>{const text=read(file);need(hash(text)===expected,'PGSTREAM_REBOOTSTRAP_REVISION_FILE_CHANGED');return JSON.parse(text);};
 const transition=load(r.planFile,r.planSha256),record=load(r.upgradeRecord,r.recordSha256),cold=load(r.coldManifest,r.coldSha256),started=load(r.startedRecord,r.startedSha256);
 need(transition.version===1&&transition.profile==='ordinary-single'&&transition.project===p.project&&transition.state===p.stateDirectory&&transition.source.sourceCommit==='d7a7ff4d513abf364622582f5f2a9147936a6d48'&&transition.target.sourceCommit==='5e112547b31252ec428747c821d3cd1b3684ce2b'&&transition.target.sourceCommit===p.source.coreCommit&&transition.target.deployCommit===p.source.deployCommit&&transition.target.image===p.imageId,'PGSTREAM_REBOOTSTRAP_REVISION_PAIR');
 need(started.planDigest===hash(JSON.stringify(transition))&&started.custody===hash(JSON.stringify(cold))&&cold.sourceCommit===transition.source.sourceCommit&&cold.deployCommit===transition.source.deployCommit&&cold.project===p.project&&record.sourceCommit===p.source.coreCommit,'PGSTREAM_REBOOTSTRAP_REVISION_CUSTODY');
 const library=transition.target.root,common=require(path.join(library,'lib/tenant-operations/common')),catalogues=require(path.join(library,'lib/tenant-operations/catalogues'));
 const target=catalogues.deploymentAdmission(ordinaryAdmission(library)).catalogues,local=catalogues.deploymentAdmission(ordinaryAdmission(path.resolve(__dirname,'../..'),library)).catalogues,source=catalogues.deploymentAdmission(ordinaryAdmission(transition.source.root,library)).catalogues;
 need(common.canonical(target)===common.canonical(local),'PGSTREAM_REBOOTSTRAP_REVISION_OPERATOR_SOURCE');
 require(path.join(library,'lib/tenant-operations/upgrade')).assertUpgradeCompatible(record,target);
 for(const entry of target)need(record.targetCatalogues.find(row=>row.kind===entry.kind)?.namespace===entry.namespace,'PGSTREAM_REBOOTSTRAP_REVISION_NAMESPACE');
 need(record.sourceCatalogues.length===source.length,'PGSTREAM_REBOOTSTRAP_REVISION_CATALOGUE');
 for(const entry of source){const captured=record.sourceCatalogues.find(row=>row.kind===entry.kind);need(captured&&captured.namespace===entry.namespace&&common.ledgerEqual(captured.ledger,common.plan([entry])[0].files),'PGSTREAM_REBOOTSTRAP_REVISION_CATALOGUE');}
 const clinical=['entries','treatments','devicestatus','profile','food','activity'];
 need(record.catalogues.length===target.length&&new Set(record.catalogues.map(row=>row.kind)).size===target.length&&record.catalogues.every(row=>target.some(entry=>entry.kind===row.kind&&entry.namespace===row.namespace)&&equal(row.applied,clinical.includes(row.kind)?['0100_'+row.kind+'_storage_identity']:[])),'PGSTREAM_REBOOTSTRAP_REVISION_NOT_IDENTITY_APPEND');
 return {transition,record,target};
}
function revisionSQL(revision){
 const quote=value=>{need(NAME.test(value),'PGSTREAM_REBOOTSTRAP_REVISION_NAMESPACE');return '"'+value+'"';};
 return 'SELECT coalesce(bool_and(ok),false) FROM ('+revision.target.map(entry=>`SELECT count(*)=${entry.catalogue.migrations.length} AND bool_and((name||':'||checksum)=ANY(ARRAY[${entry.catalogue.migrations.map(m=>"'"+m.name+':'+m.checksum+"'").join(',')}]::text[])) AS ok FROM ${quote(entry.namespace)}.schema_migrations`).concat(['entries','treatments','devicestatus','profile','food','activity'].map(kind=>{const entry=revision.target.find(x=>x.kind===kind);return `SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${entry.namespace}' AND c.relname='${kind}' AND c.relreplident='f') AS ok`;})).join(' UNION ALL ')+') checks;';
}
function claimRevision(p){
 if(p.action!=='replace-revision')return;
 const directory=path.dirname(p.revision.upgradeRecord),file=path.join(directory,'revision-slot-started.json');let fd;
 try{fd=fs.openSync(file,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw fail('PGSTREAM_REBOOTSTRAP_REVISION_ALREADY_STARTED');throw error;}
 try{fs.writeFileSync(fd,JSON.stringify({version:1,revision:p.revision,slot:p.slot,receiptFile:p.receiptFile})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const parent=fs.openSync(directory,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
}
async function run(p,{docker=platform(),routes}={}){
 plan(p);const envFile=p.environmentFile||path.join(p.deploymentDirectory,'.env'),env=Object.fromEntries(read(envFile).trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
 need(env.NS_DEMO_PROJECT===p.project&&env.NS_DEMO_STATE===p.stateDirectory&&env.NS_SOURCE_COMMIT===p.source.coreCommit&&env.NS_PGSTREAM==='1','PGSTREAM_REBOOTSTRAP_PREPARATION');
 const complete=JSON.parse(read(path.join(p.stateDirectory,'bootstrap/complete.json')));need(complete.sourceCommit===p.source.coreCommit&&complete.deployCommit===p.source.deployCommit,'PGSTREAM_REBOOTSTRAP_PREPARATION_SOURCE');
 need(path.dirname(p.evaluatorConfig)===path.join(p.stateDirectory,'evaluator'),'PGSTREAM_REBOOTSTRAP_CONFIG_PATH');const c=JSON.parse(read(p.evaluatorConfig));need(c.pgstream?.slot===p.slot&&/^[a-f0-9]{32}$/.test(c.pgstream.generation)&&c.postgres&&SHA.test(p.evaluatorConfigSha256)&&hash(read(p.evaluatorConfig))===p.evaluatorConfigSha256,'PGSTREAM_REBOOTSTRAP_CONFIG');
 routes=routes||require('../../lib/pgstream/evaluator').routes({...c,namespaces:c.postgres.namespaces});
 const wireFile=path.join(p.stateDirectory,'pgstream','pgstream.yaml'),wireText=read(wireFile);need(SHA.test(p.wireConfigSha256)&&hash(wireText)===p.wireConfigSha256,'PGSTREAM_REBOOTSTRAP_WIRE_CONFIG');
 const wire=JSON.parse(wireText),source=wire.source?.postgres,target=wire.target?.webhooks;
 // Recovery admits both historical uncached and current cached wire. The
 // stopped worker discards its cache; exact stored subscriptions are checked below.
 need(source?.mode==='replication'&&source.replication?.replication_slot===p.slot&&new URL(source.url).username===c.pgstream.streamRole&&decodeURIComponent(new URL(source.url).pathname)==='/'+p.database.name&&source.replication.plugin.add_tables.split(',').sort().join(',')===routes.map(row=>row.schema+'.'+row.table).sort().join(',')&&source.replication.plugin.include_xids===true&&source.replication.plugin.include_transactions===true&&target?.notifier?.strict_mode===true&&target.notifier.transaction_batch?.max_rows===(c.maxRows??10000)&&target.notifier.transaction_batch?.max_bytes===c.pgstream.receiver.maxBytes,'PGSTREAM_REBOOTSTRAP_WIRE_CONFIG');
 const composeArgs=files=>['compose','--project-name',p.project,'--project-directory',p.deploymentDirectory,'--env-file',envFile,...files.flatMap(file=>['-f',file])];
 const verifyFiles=()=>{for(const file of p.approvedHistoricalComposeFiles)need(hash(read(file.path))===file.sha256,'PGSTREAM_REBOOTSTRAP_APPROVED_FILE_CHANGED');};
 const snapshot=()=>{
  verifyFiles();const compose=JSON.parse(docker([...composeArgs(p.composeFiles),'config','--format','json']));const ids=docker(['ps','-aq','--filter','label=com.docker.compose.project='+p.project]).trim().split(/\s+/).filter(Boolean);need(ids.length>0,'PGSTREAM_REBOOTSTRAP_NO_CONTAINERS');const rows=JSON.parse(docker(['inspect',...ids])),historicalHashes={};
  for(const key of new Set([JSON.stringify(p.composeFiles),...p.containers.map(row=>JSON.stringify(row.composeFiles||p.composeFiles))]))historicalHashes[key]=Object.fromEntries(docker([...composeArgs(JSON.parse(key)),'config','--hash','*']).trim().split('\n').map(line=>line.trim().split(/\s+/)));
  verifyFiles();return validateSnapshot(p,rows,compose,JSON.parse(docker(['image','inspect',p.imageId]))[0],historicalHashes[JSON.stringify(p.composeFiles)],historicalHashes);
 };
 let current=snapshot();const query=sql=>docker(['exec','-i',current.postgres.Id,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',p.operatorRole,'-d',p.database.name],sql);
 const inspect=()=>{const row=JSON.parse(query(sqlInspection(p,c)));validateDatabase(p,c,row,routes);return row;};
 const verifyRevision=async()=>{if(p.action==='replace-revision'){
  const revision=revisionRecord(p),transition=revision.transition,cold=JSON.parse(read(p.revision.coldManifest));
  need(equal(Object.keys(cold.files||{}).sort(),['deployment.env','postgres-data.tar','state.tar','vault-data.tar']),'PGSTREAM_REBOOTSTRAP_REVISION_CUSTODY');
  need(path.dirname(p.revision.coldManifest)===transition.coldBackup,'PGSTREAM_REBOOTSTRAP_REVISION_CUSTODY');
  const oldImage=JSON.parse(docker(['image','inspect',cold.imageId]))[0];
  need(oldImage.Id===cold.imageId&&oldImage.Config?.Labels?.['org.opencontainers.image.revision']===transition.source.sourceCommit&&oldImage.Config.Labels['org.nightscout.deploy.revision']===transition.source.deployCommit,'PGSTREAM_REBOOTSTRAP_REVISION_CUSTODY');
  for(const [file,expected]of Object.entries(cold.files))need(execFileSync('sha256sum',['--',path.join(transition.coldBackup,file)],{encoding:'utf8'}).split(' ')[0]===expected,'PGSTREAM_REBOOTSTRAP_REVISION_CUSTODY');
  const artifact=await require('../../lib/tenant-operations/filesystem').loadArtifact({directory:transition.directory,name:revision.record.backup.name});
  need(artifact.digest===revision.record.backup.digest&&artifact.manifest.sourceCommit===transition.source.sourceCommit,'PGSTREAM_REBOOTSTRAP_REVISION_BACKUP');
  need(query(revisionSQL(revision)).trim()==='t','PGSTREAM_REBOOTSTRAP_REVISION_SCHEMA');
 }};
 await verifyRevision();const before=inspect();const receipt={version:1,operation:'pgstream-rebootstrap',state:'INSPECTED_STOPPED',source:{coreCommit:p.source.coreCommit,deployCommit:p.source.deployCommit},slot:p.slot,action:p.action,...(p.revision?{revision:p.revision}:{}),receiptFile:p.receiptFile,evaluatorConfigSha256:p.evaluatorConfigSha256,wireConfigSha256:p.wireConfigSha256,imageId:p.imageId,project:p.project,database:Object.fromEntries(['name','oid','systemIdentifier','postmasterStartedAt'].map(key=>[key,p.database[key]])),containers:p.containers.map(row=>Object.fromEntries(['cid','service','imageId','startedAt','configHash','composeFiles','originalRestartPolicy'].filter(key=>row[key]!==undefined).map(key=>[key,key==='originalRestartPolicy'?{Name:row[key].Name,MaximumRetryCount:row[key].MaximumRetryCount}:row[key]]))),helperSha256:hash(read(__filename)),next:'Keep all effect-serving roles stopped. Start the evaluator and separate pgstream service explicitly for startup source/slot validation and existing reconciliation/pending/due recovery. Independently verify current physical clocks/output and due progress before reopening effects.'};
 fs.writeFileSync(p.receiptFile,JSON.stringify(receipt)+'\n',{mode:0o600,flag:'wx'});
 try{
  current=snapshot();inspect();await verifyRevision();receipt.state='SLOT_OPERATION_STARTED';fs.writeFileSync(p.receiptFile,JSON.stringify(receipt)+'\n',{mode:0o600});
  claimRevision(p);
  // A PostgreSQL slot name is reusable. Rotate the deployment incarnation
  // before replacing it so durable clinical/raw coverage cannot adopt a new
  // slot under the previous generation. Every effect-serving role is stopped.
  {
   need(/^[a-f0-9]{32}$/.test(c.pgstream.generation),'PGSTREAM_REBOOTSTRAP_STREAM_GENERATION');
   const next={...c,pgstream:{...c.pgstream,generation:require('node:crypto').randomBytes(16).toString('hex')}};
   const temporary=p.evaluatorConfig+'.rebootstrap-'+process.pid;
   const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(next)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   fs.renameSync(temporary,p.evaluatorConfig);const parent=fs.openSync(path.dirname(p.evaluatorConfig),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
   receipt.streamGeneration=next.pgstream.generation;receipt.nextEvaluatorConfigSha256=hash(read(p.evaluatorConfig));
  }
  query(slotSQL(p));current=snapshot();const after=JSON.parse(query(sqlInspection(p,c)));
  need(after.database===before.database&&after.databaseOid===before.databaseOid&&after.systemIdentifier===before.systemIdentifier&&after.postmasterStartedAt===before.postmasterStartedAt&&after.otherClients===0,'PGSTREAM_REBOOTSTRAP_BACKEND_CHANGED');
  need(after.slot?.database===p.database.name&&after.slot.plugin==='wal2json'&&after.slot.active===false&&after.slot.restart!==null&&after.slot.status!=='lost','PGSTREAM_REBOOTSTRAP_NEW_SLOT_INVALID');
  need(equal(after.role,before.role)&&equal(normalized(after.subscriptions),normalized(before.subscriptions)),'PGSTREAM_REBOOTSTRAP_METADATA_CHANGED');receipt.state='SLOT_RECREATED_EFFECTS_STOPPED';
 }catch(error){receipt.state='REFUSED_KEEP_STOPPED';receipt.error=/^PGSTREAM_REBOOTSTRAP_[A-Z_]+$/.test(error.code||'')?error.code:'PGSTREAM_REBOOTSTRAP_REFUSED';throw fail(receipt.error);}
 finally{fs.writeFileSync(p.receiptFile,JSON.stringify(receipt)+'\n',{mode:0o600});}
 return receipt;
}
if(require.main===module){(async()=>{need(process.argv.length===3,'PGSTREAM_REBOOTSTRAP_USAGE');const result=await run(JSON.parse(read(process.argv[2])));process.stdout.write(JSON.stringify({operation:result.operation,state:result.state,receiptFile:result.receiptFile})+'\n');})().catch(error=>{process.stderr.write((/^PGSTREAM_REBOOTSTRAP_[A-Z_]+$/.test(error.code||'')?error.code:'PGSTREAM_REBOOTSTRAP_REFUSED')+'\n');process.exitCode=1;});}
module.exports={run,plan,validateSnapshot,validateDatabase,slotSQL,sqlInspection,ordinaryAdmission,revisionRecord,revisionSQL,claimRevision};
