'use strict';
// Host-private digest custody. Request-facing restore accepts only a digest;
// directory and capture identity derive from this sealed catalogue.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{isDeepStrictEqual:equal}=require('node:util');
const F=require('./connection-budget-files'),B=require('./connection-budget'),C=require('./control-recovery');
const LIMIT=16*1024*1024,HEX=/^[a-f0-9]{64}$/;
const need=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function boundedBytes(file){
 const fd=await fs.promises.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const stat=await fd.stat();need(stat.isFile()&&stat.nlink===1&&stat.uid===process.getuid()&&!(stat.mode&0o077)&&stat.size<=LIMIT,'LIFECYCLE_ARTIFACT_BOUND');
  const bytes=Buffer.alloc(Math.min(stat.size+1,LIMIT+1));let offset=0;
  while(offset<bytes.length){const {bytesRead}=await fd.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
  need(offset===stat.size&&offset<=LIMIT,'LIFECYCLE_ARTIFACT_CHANGED');const after=await fd.stat();need(after.size===stat.size&&after.mtimeMs===stat.mtimeMs&&after.ctimeMs===stat.ctimeMs,'LIFECYCLE_ARTIFACT_CHANGED');return bytes.subarray(0,offset);
 }finally{await fd.close();}
}
// Core validation and durability stay authoritative. Its loader sees only the
// prebounded immutable bytes, eliminating a second unbounded read/race.
async function load(directory,digest){
 need(typeof digest==='string'&&HEX.test(digest),'LIFECYCLE_ARTIFACT_DIGEST');
 const root=F.directory(directory),name='tenant-artifact-'+digest;let child;
 try{need(equal(fs.readdirSync('/proc/self/fd/'+root).sort(),[name]),'LIFECYCLE_ARTIFACT_CONTENTS');child=F.directory(path.join(directory,name));need(equal(fs.readdirSync('/proc/self/fd/'+child),['artifact.json']),'LIFECYCLE_ARTIFACT_CONTENTS');const bytes=await boundedBytes(F.location(child,'artifact.json'));
  const exactFile=path.join(directory,name,'artifact.json');
  const io={...fs.promises,async open(file,flags){if(file!==exactFile)return fs.promises.open(file,flags);const stat=await fs.promises.stat(F.location(child,'artifact.json'));return {async stat(){return stat;},async readFile(){return bytes.toString('utf8');},async close(){}};}};
  const artifact=await require('../../lib/tenant-lifecycle/filesystem-artifact').loadTenantArtifact({directory,digest,io});return {artifact,bytes:bytes.length,bytesSha256:hash(bytes)};
 }finally{if(child!==undefined)fs.closeSync(child);fs.closeSync(root);}
}
async function saveCapture(artifact,directory){
 const raw=Buffer.from(JSON.stringify(artifact)+'\n');need(raw.length<=LIMIT,'LIFECYCLE_ARTIFACT_BOUND');
 // Exact per-lease output root is exclusively created before the fixed child.
 const fd=F.directory(directory);try{need(fs.readdirSync('/proc/self/fd/'+fd).length===0,'LIFECYCLE_ARTIFACT_OUTPUT_REUSED');}finally{fs.closeSync(fd);}
 await require('../../lib/tenant-lifecycle/filesystem-artifact').saveTenantArtifact(artifact,{directory});return load(directory,artifact.digest);
}
function create({directory,plan}){
 const base=F.directory(directory);fs.closeSync(base);
 function captureDirectory(incarnation){need(/^[a-f0-9]{32}$/.test(incarnation),'LIFECYCLE_ARTIFACT_CAPTURE');return path.join(directory,'captures',incarnation);}
 function recordFd(){return F.directory(path.join(directory,'catalogue'));}
 async function publish(book,row,value,receipt){
  C.validate(plan,book);const request=C.intent('lifecycle-operator',value);
  need(book.controlLeases.includes(row)&&row.class==='lifecycle-operator'&&row.state==='CLOSED'&&request.command==='capture'&&B.hash(request)===row.intentSha256&&receipt.version===2&&receipt.kind==='controlled-operation-complete'&&receipt.class===row.class&&receipt.incarnation===row.incarnation&&receipt.nonce===row.nonce&&receipt.planSha256===plan.sha256&&equal(receipt.source,plan.source)&&receipt.intentSha256===row.intentSha256&&equal(receipt.container,row.container)&&receipt.outcome==='COMPLETED'&&receipt.result?.tenant===request.tenant&&HEX.test(receipt.result?.digest),'LIFECYCLE_ARTIFACT_CAPTURE_NOT_CLOSED');
  const digest=receipt.result.digest,location=captureDirectory(row.incarnation),loaded=await load(location,digest);
  need(loaded.artifact.manifest.tenant===request.tenant&&loaded.artifact.manifest.sourceCommit===plan.source.coreCommit,'LIFECYCLE_ARTIFACT_PROVENANCE');
  // Seal bytes and directory before publishing catalogue success. Retain every
  // failed/original capture; never replace or replay an existing publication.
  const child=F.directory(path.join(location,'tenant-artifact-'+digest));try{fs.chmodSync(F.location(child,'artifact.json'),0o400);const file=fs.openSync(F.location(child,'artifact.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(file);}finally{fs.closeSync(file);}fs.fchmodSync(child,0o500);fs.fsyncSync(child);}finally{fs.closeSync(child);}
  const capture=F.directory(location);try{fs.fchmodSync(capture,0o500);fs.fsyncSync(capture);}finally{fs.closeSync(capture);}
  const fd=recordFd();try{const record={version:1,digest,bytes:loaded.bytes,bytesSha256:loaded.bytesSha256,tenant:request.tenant,source:structuredClone(plan.source),planSha256:plan.sha256,captureIncarnation:row.incarnation};F.writeAt(fd,digest+'.json',record,{exclusive:true});fs.chmodSync(F.location(fd,digest+'.json'),0o400);const sealed=fs.openSync(F.location(fd,digest+'.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(sealed);}finally{fs.closeSync(sealed);}fs.fsyncSync(fd);return record;}finally{fs.closeSync(fd);}
 }
 async function resolve(digest,tenant){
  need(typeof digest==='string'&&HEX.test(digest)&&plan.lifecycleOperator.tenants.includes(tenant),'LIFECYCLE_ARTIFACT_SELECTION');const fd=recordFd();let record;
  try{record=F.readAt(fd,digest+'.json');}finally{fs.closeSync(fd);}
  need(record&&equal(Object.keys(record).sort(),['version','digest','bytes','bytesSha256','tenant','source','planSha256','captureIncarnation'].sort())&&record.version===1&&record.digest===digest&&record.tenant===tenant&&equal(record.source,plan.source)&&record.planSha256===plan.sha256&&Number.isSafeInteger(record.bytes)&&record.bytes>0&&record.bytes<=LIMIT&&HEX.test(record.bytesSha256),'LIFECYCLE_ARTIFACT_CATALOGUE');
  const location=captureDirectory(record.captureIncarnation),loaded=await load(location,digest);
  need(loaded.bytes===record.bytes&&loaded.bytesSha256===record.bytesSha256&&loaded.artifact.manifest.tenant===tenant&&loaded.artifact.manifest.sourceCommit===plan.source.coreCommit,'LIFECYCLE_ARTIFACT_CATALOGUE_CHANGED');
  return {artifact:loaded.artifact,directory:location,digest,bytes:record.bytes,bytesSha256:record.bytesSha256};
 }
 return Object.freeze({captureDirectory,publish,resolve});
}
module.exports={LIMIT,boundedBytes,load,saveCapture,create};
