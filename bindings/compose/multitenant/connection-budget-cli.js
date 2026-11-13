#!/usr/bin/env node
'use strict';
// Explicit selected-profile lifecycle only. No command or SQL is taken from a
// profile; no default path, automatic retry, resize, cleanup or resource epoch reset.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path'),{spawnSync}=require('node:child_process');
const F=require('./connection-budget-files'),B=require('./connection-budget');
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
function run(args){const r=spawnSync('docker',args,{encoding:'utf8',timeout:15000,maxBuffer:1048576,killSignal:'SIGKILL',stdio:['ignore','pipe','pipe']});need(!r.error&&r.status===0,'CONNECTION_CONTROLLER_DOCKER_REFUSED');return r.stdout;}
function main(args){
 need(args.length>=2&&args.length<=3&&['bind','start','stop'].includes(args[1])&&path.isAbsolute(args[0]),'CONNECTION_CONTROLLER_ARGUMENTS');
 need(!process.env.DOCKER_HOST&&!process.env.DOCKER_CONTEXT&&!process.env.DOCKER_TLS_VERIFY&&!process.env.DOCKER_CERT_PATH,'CONNECTION_CONTROLLER_LOCAL_DOCKER_ONLY');
 const directory=path.join(args[0],'connection-budget'),config=F.read(path.join(directory,'controller-config.json')),plan=F.read(path.join(directory,'plan.json'));
 need(plan.source?.coreCommit===B.REVIEWED_CORE_COMMIT,'CONNECTION_BUDGET_UNREVIEWED_SOURCE');
 need(B.hash((({sha256,...b})=>b)(plan))===plan.sha256&&JSON.stringify(config.source)===JSON.stringify(plan.source),'CONNECTION_CONTROLLER_PLAN');
 need(config.fileDigests&&[...config.composeFiles,path.join(config.workingDirectory,'.env')].every(file=>{const stat=fs.lstatSync(file);return stat.isFile()&&!stat.isSymbolicLink()&&fs.realpathSync(file)===file&&config.fileDigests[file]===crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}),'CONNECTION_CONTROLLER_PREPARED_FILES_CHANGED');
 const complete=F.read(path.join(args[0],'bootstrap','complete.json'));need(complete.sourceCommit===plan.source.coreCommit&&complete.deployCommit===plan.source.deployCommit,'CONNECTION_CONTROLLER_BOOTSTRAP_SOURCE');
 if(args[1]==='bind'){
   need(args.length===2,'CONNECTION_CONTROLLER_ARGUMENTS');
   return F.locked(directory,fd=>{
     need(!F.inspect(fd,'custody.json'),'CONNECTION_CONTROLLER_ALREADY_BOUND');
     const image=JSON.parse(run(['image','inspect',config.image]));need(image.length===1,'CONNECTION_CONTROLLER_IMAGE');const labels=image[0]?.Config?.Labels||{};
     need(labels['org.opencontainers.image.revision']===plan.source.coreCommit&&labels['org.nightscout.deploy.revision']===plan.source.deployCommit,'CONNECTION_CONTROLLER_IMAGE_SOURCE');
     const compose=['compose','--project-directory',config.workingDirectory,'--project-name',config.project,'--env-file',path.join(config.workingDirectory,'.env'),...config.composeFiles.flatMap(f=>['-f',f])];
     const cid=run([...compose,'ps','-a','-q','postgres']).trim();need(/^[a-f0-9]{64}$/.test(cid),'CONNECTION_CONTROLLER_POSTGRES');
     const pg=JSON.parse(run(['inspect',cid]));need(pg.length===1,'CONNECTION_CONTROLLER_POSTGRES');const p=pg[0],l=p.Config?.Labels||{};
     need(p.State?.Running===true&&l['com.docker.compose.project']===config.project&&l['com.docker.compose.project.working_dir']===config.workingDirectory&&l['com.docker.compose.service']==='postgres','CONNECTION_CONTROLLER_POSTGRES_CUSTODY');
     const custody={expected:{project:config.project,workingDirectory:config.workingDirectory,imageId:image[0].Id,source:plan.source},postgres:{cid,startedAt:p.State.StartedAt,imageId:p.Image},composeFiles:config.composeFiles,fileDigests:config.fileDigests};
     // Verify actual target identity/settings BEFORE publishing controller custody.
     const ports=require('./connection-budget-docker').create({directory,plan,...custody});F.writeAt(fd,'observer-claim.json',{kind:'bounded-observer-in-flight',planSha256:plan.sha256},{exclusive:true});B.observedResourceMatches(plan,ports.observe(plan,[],[]));fs.unlinkSync(F.location(fd,'observer-claim.json'));fs.fsyncSync(fd);
     F.writeAt(fd,'custody.json',custody,{exclusive:true});return{state:'BOUND',authorization:plan.authorization};
   });
 }
 need(args.length===3&&plan.slots.some(s=>s.processInstanceId===args[2]),'CONNECTION_ADMISSION_UNPLANNED_WORKER');
 const custody=F.read(path.join(directory,'custody.json'));need(JSON.stringify(custody.expected.source)===JSON.stringify(plan.source),'CONNECTION_CONTROLLER_PLAN');
 const ports=require('./connection-budget-docker').create({directory,plan,...custody});
 return require('./connection-budget-controller').create({directory,plan,expected:custody.expected,ports})[args[1]](args[2]);
}
if(require.main===module){try{process.stdout.write(JSON.stringify(main(process.argv.slice(2)))+'\n');}catch(e){process.stderr.write(JSON.stringify({error:/^[A-Z0-9_]{1,100}$/.test(e?.code||'')?e.code:'CONNECTION_CONTROLLER_REFUSED'})+'\n');process.exitCode=1;}}
module.exports={main};
