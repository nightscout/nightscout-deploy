'use strict';
// Source-fixed private launcher. Only sealed class files, one-use action/ticket,
// claims and the selected bounded artifact are mounted. This is not a command API.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{isDeepStrictEqual:equal}=require('node:util');
const F=require('./connection-budget-files'),C=require('./control-recovery'),B=require('./connection-budget');
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
function privateBytes(file){
 const parent=F.directory(path.dirname(file));let fd;
 try{F.inspect(parent,path.basename(file));fd=fs.openSync(F.location(parent,path.basename(file)),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const before=fs.fstatSync(fd);need(before.isFile()&&before.nlink===1&&[process.getuid(),1000].includes(before.uid)&&!(before.mode&0o077)&&before.size<=1048576,'CONTROL_RECOVERY_PRIVATE_FILE');const raw=fs.readFileSync(fd),after=fs.fstatSync(fd);need(raw.length===before.size&&after.size===before.size&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs,'CONTROL_RECOVERY_FILES_CHANGED');JSON.parse(raw);return raw;
 }finally{if(fd!==undefined)fs.closeSync(fd);fs.closeSync(parent);}
}
const hash=file=>crypto.createHash('sha256').update(privateBytes(file)).digest('hex');
function create({directory,plan,expected,postgres,docker,checkPg,inspectCid,convert}){
 const state=path.dirname(directory);let catalogue;
 const artifacts=()=>catalogue||(catalogue=require('./lifecycle-artifact-catalogue').create({directory:path.join(directory,'artifacts'),plan}));
 function root(row){need(['lifecycle-operator','restore-commissioner'].includes(row.class)&&/^[a-f0-9]{32}$/.test(row.incarnation),'CONTROL_RECOVERY_CLASS');return path.join(directory,row.class,row.incarnation);}
 function durable(row,states){const book=F.read(path.join(directory,'ledger.json'));C.validate(plan,book);const actual=book.controlLeases.find(r=>r.incarnation===row.incarnation);need(actual&&equal(actual,row)&&states.includes(actual.state),'CONTROL_RECOVERY_DURABLE_ROW');return actual;}
 function source(row){return row.class==='lifecycle-operator'?path.join(state,'ops'):path.join(state,'restore-commissioner');}
 function roster(row){return row.class==='lifecycle-operator'?plan.lifecycleOperator.files:plan.restoreCommissioner?.files;}
 function mkdir(dir,owner=1000){fs.mkdirSync(dir,{mode:0o700});fs.chownSync(dir,owner,1000);const parent=F.directory(path.dirname(dir));try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
 function write(file,value){F.write(file,value,{exclusive:true});fs.chownSync(file,1000,1000);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 function snapshotFile(from,to){const raw=privateBytes(from),fd=fs.openSync(to,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,raw);fs.fchownSync(fd,1000,1000);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 function sealed(row){const expectedFiles=['env.json','config.json',...(row.class==='lifecycle-operator'&&plan.lifecycleOperator.placement?['placement.json']:[])];need(roster(row)&&equal(Object.keys(roster(row)).sort(),expectedFiles.sort())&&Object.values(roster(row)).every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)),'CONTROL_RECOVERY_FILE_ROSTER');const files={'env.json':path.join(source(row),'env.json'),'config.json':path.join(source(row),'config.json')};if(row.class==='lifecycle-operator'&&plan.lifecycleOperator.placement)files['placement.json']=path.join(state,'placement','backend.json');
  const result={};for(const [name,file]of Object.entries(files)){result[name]=hash(file);}need(equal(result,roster(row)),'CONTROL_RECOVERY_FILES_CHANGED');return files;
 }
 async function controlArtifact(p,row,request){
  need(equal(p,plan),'CONTROL_RECOVERY_PLAN');durable(row,['ISSUED']);C.intent(row.class,request);
  // No private controller lock is held over a core artifact load.
  need(!fs.existsSync(path.join(directory,'controller.lock')),'CONTROL_RECOVERY_ARTIFACT_LOCK');
  if(request.command==='restore'){
   const selected=await artifacts().resolve(request.artifactDigest,request.tenant);
   durable(row,['ISSUED']);
   // Host-only selection record stores no caller path. The narrow location is
   // rederived from the sealed catalogue immediately before child creation.
   F.write(path.join(directory,'artifacts','selection-'+row.incarnation+'.json'),{digest:selected.digest,bytes:selected.bytes,bytesSha256:selected.bytesSha256},{exclusive:true});
  }else{need(request.command==='capture','CONTROL_RECOVERY_INTENT');mkdir(artifacts().captureDirectory(row.incarnation));}
 }
 function controlFiles(p,row,request){
  need(equal(p,plan)&&B.hash(C.intent(row.class,request))===row.intentSha256,'CONTROL_RECOVERY_INTENT');durable(row,['ISSUED']);const files=sealed(row),base=root(row);mkdir(base);
  for(const name of ['view','claims','operator-env','operator-config',...(Object.hasOwn(files,'placement.json')?['placement']:[])])mkdir(path.join(base,name));
  snapshotFile(files['env.json'],path.join(base,'operator-env','env.json'));snapshotFile(files['config.json'],path.join(base,'operator-config','config.json'));
  if(files['placement.json'])snapshotFile(files['placement.json'],path.join(base,'placement','backend.json'));
  write(path.join(base,'view','action.json'),request);const result=publishedFiles(row);
  // Only raw bytes are sealed here; semantic action hash remains distinct.
  for(const name of ['view','operator-env','operator-config',...(files['placement.json']?['placement']:[])]){const fd=F.directory(path.join(base,name));try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  return result;
 }
 function publishedFiles(row){const base=root(row),files={'env.json':hash(path.join(base,'operator-env','env.json')),'config.json':hash(path.join(base,'operator-config','config.json')),...(row.class==='lifecycle-operator'&&plan.lifecycleOperator.placement?{'placement.json':hash(path.join(base,'placement','backend.json'))}:{})};need(equal(files,roster(row)),'CONTROL_RECOVERY_FILES_CHANGED');return {...files,'action.json':hash(path.join(base,'view','action.json'))};}
 function ticketRow(ticket){require('./physical-ticket-receiver').ticket(ticket,ticket.processInstanceId);const row=F.read(path.join(directory,'ledger.json')).controlLeases.find(r=>r.incarnation===ticket.incarnation);need(row&&row.class===ticket.processInstanceId&&row.intentSha256===ticket.control.intentSha256&&equal(row.principal,ticket.control.principal),'CONTROL_RECOVERY_TICKET');durable(row,['ISSUED','BOUND']);return row;}
 function controlTicket(ticket,request){const row=ticketRow(ticket);need(row.state==='ISSUED'&&B.hash(C.intent(row.class,request))===row.intentSha256,'CONTROL_RECOVERY_TICKET');sealed(row);const base=root(row);const actual=publishedFiles(row);need(equal(actual,ticket.control.files),'CONTROL_RECOVERY_FILES_CHANGED');write(path.join(base,'view','ticket.json'),ticket);}
 function controlStart(ticket){
  const row=ticketRow(ticket);need(row.state==='ISSUED','CONTROL_RECOVERY_BINDING');sealed(row);need(equal(publishedFiles(row),ticket.control.files),'CONTROL_RECOVERY_FILES_CHANGED');checkPg();
  const pg=inspectCid(postgres.cid),network=expected.project+'_backend',networks=pg.NetworkSettings?.Networks;
  need(networks&&equal(Object.keys(networks),[network])&&Array.isArray(networks[network].Aliases)&&networks[network].Aliases.includes('postgres'),'CONTROL_RECOVERY_NETWORK');
  const base=root(row),action=C.intent(row.class,F.read(path.join(base,'view','action.json')));
  const mount=(from,to,readOnly=true)=>['--mount','type=bind,src='+from+',dst='+to+(readOnly?',readonly':'')];
  const mounts=[...mount(path.join(base,'operator-config'),'/run/ns-operator-config'),...mount(path.join(base,'operator-env'),'/run/ns-operator-env'),...mount(path.join(base,'view'),'/run/ns-operator-ticket'),...mount(path.join(base,'claims'),'/run/ns-operator-claims',false)];
  if(row.class==='lifecycle-operator'&&plan.lifecycleOperator.placement)mounts.push(...mount(path.join(base,'placement'),'/run/ns-placement'));
  if(['capture','restore'].includes(action.command)){
   let location=artifacts().captureDirectory(row.incarnation);
   if(action.command==='restore'){
    const selection=F.read(path.join(directory,'artifacts','selection-'+row.incarnation+'.json')),record=F.read(path.join(directory,'artifacts','catalogue',action.artifactDigest+'.json'));
    need(selection.digest===action.artifactDigest&&record.digest===selection.digest&&record.bytes===selection.bytes&&record.bytesSha256===selection.bytesSha256&&record.tenant===action.tenant&&record.planSha256===plan.sha256&&equal(record.source,plan.source),'LIFECYCLE_ARTIFACT_CATALOGUE_CHANGED');
    location=artifacts().captureDirectory(record.captureIncarnation);
   }
   mounts.push(...mount(location,'/run/ns-operator-artifact',action.command==='restore'));
  }
  const args=['create','--pull','never','--init','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--network',network,'--restart','no','--tmpfs','/tmp:rw,noexec,nosuid,size=16m',
   '--label','com.docker.compose.project='+expected.project,'--label','com.docker.compose.project.working_dir='+expected.workingDirectory,'--label','com.docker.compose.service='+row.class,'--label','org.nightscout.control.incarnation='+row.incarnation,...mounts,
   '--entrypoint','node',expected.imageId,'deploy/multitenant/'+row.class+'-entry.js'];
  const cid=docker(args).trim();need(/^[a-f0-9]{64}$/.test(cid),'CONTROL_RECOVERY_CID');
  F.write(path.join(base,'child.json'),{cid,incarnation:row.incarnation,class:row.class},{exclusive:true});docker(['start',cid]);
 }
 function controlInspect(row){
  durable(row,['ISSUED','BOUND','UNKNOWN']);const child=F.read(path.join(root(row),'child.json'));need(equal(Object.keys(child).sort(),['cid','class','incarnation'])&&child.incarnation===row.incarnation&&child.class===row.class,'CONTROL_RECOVERY_CHILD');
  const raw=inspectCid(child.cid),out=convert(raw),image=JSON.parse(docker(['image','inspect',raw.Image]))[0],labels=image?.Config?.Labels||{};
  need(raw.Id===child.cid&&raw.Config?.Labels?.['org.nightscout.control.incarnation']===row.incarnation,'CONTROL_RECOVERY_CHILD');out.source={coreCommit:labels['org.opencontainers.image.revision'],deployCommit:labels['org.nightscout.deploy.revision']};
  return {...out,restarting:raw.State?.Restarting,restartPolicy:raw.HostConfig?.RestartPolicy?.Name};
 }
 function controlGate(ticket,gate){const row=ticketRow(ticket);need(row.state==='BOUND'&&equal((book=>C.gate(plan,book,book.controlLeases.find(r=>r.incarnation===row.incarnation)))(F.read(path.join(directory,'ledger.json'))),gate),'CONTROL_RECOVERY_GATE');sealed(row);need(equal(publishedFiles(row),ticket.control.files),'CONTROL_RECOVERY_FILES_CHANGED');write(path.join(root(row),'view','gate.json'),gate);}
 function find(incarnation){need(/^[a-f0-9]{32}$/.test(incarnation),'CONTROL_RECOVERY_INCARNATION');const book=F.read(path.join(directory,'ledger.json'));C.validate(plan,book);const row=book.controlLeases.find(r=>r.incarnation===incarnation);need(row,'CONTROL_RECOVERY_CHILD');return row;}
 function controlWait(incarnation){const row=find(incarnation),child=F.read(path.join(root(row),'child.json'));need(docker(['wait',child.cid],35000).trim()==='0','CONTROL_RECOVERY_CHILD_FAILED');}
 function controlReceipt(row){durable(row,['BOUND','CLOSED']);return F.read(path.join(root(row),'claims','complete.json'));}
 async function controlPublish(p,book,row,request){need(equal(p,plan),'CONTROL_RECOVERY_PLAN');const current=book.controlLeases.find(r=>r.incarnation===row.incarnation);need(equal(current,row),'CONTROL_RECOVERY_ROW');return artifacts().publish(book,current,request,controlReceipt(row));}
 return Object.freeze({controlVersion:2,commissionVersion:1,controlArtifact,controlFiles,controlTicket,controlStart,controlInspect,controlGate,controlWait,controlReceipt,controlPublish});
}
module.exports={create};
