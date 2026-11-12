'use strict';
// Bounded operator diagnostics. Raw streams/errors stay in one private artifact;
// public summaries contain typed stages/codes and placement identity only.
const fs=require('node:fs'),path=require('node:path'),journal=require('./replacement-journal');
const prefixes=/^(?:PLACEMENT_|REALTIME_|LIFECYCLE_|RESTORE_|ACTIVITY_|TENANT_|STORAGE_|SOCKET_|POOL_|SETTINGS_|SHIPPING_MOVE_|SYNTHETIC_|FIXTURE_)[A-Z0-9_]{1,80}$/;
const system=new Set(['EPIPE','ECONNRESET','ETIMEDOUT','ECONNREFUSED','ERR_ASSERTION','ABORT_ERR','ENOSPC','EACCES','ENOENT','EIO','42501','28P01','57014','57P01','42P01','08006','40P01','53300','55P03','25P02']);
function code(value){return typeof value==='string'&&(prefixes.test(value)||system.has(value))?value:'UNCLASSIFIED_ERROR';}
function stage(value){return typeof value==='string'&&/^[a-z][a-z0-9-]{0,95}$/.test(value)?value:'unclassified';}
function create({state,operation,identity,now=()=>performance.now()}){
 const started=now(),directory=path.join(state,'operator-diagnostics'),file=path.join(directory,'replacement-'+operation+'.json');
 const data={version:1,operation,identity,events:[],eventsTotal:0,child:{exitCode:null,signal:null,completionSeen:false,stderrCodes:[]},hostFailure:null,captureError:null,errorsTotal:0,errorsTruncated:false,privateLimits:{streamChars:16384,errorCount:8,errorChars:4096},streams:{stdout:{chars:0,truncated:false},stderr:{chars:0,truncated:false}}};
 const raw={stdout:'',stderr:'',errors:[]};
 function summary(){return JSON.parse(JSON.stringify(data));}
 function flush(){try{if(!fs.existsSync(directory))fs.mkdirSync(directory,{mode:0o700});const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077)throw Object.assign(new Error('private diagnostic directory required'),{code:'PLACEMENT_DIAGNOSTIC_PRIVATE_DIR_REQUIRED'});journal.atomicJson(file,{...data,private:raw},true);}catch(error){data.captureError=code(error?.code);}}
 function event(kind,details={}){data.eventsTotal++;data.events.push({...details,kind,atMs:Math.max(0,Math.ceil(now()-started))});if(data.events.length>128)data.events.shift();flush();}
 function failure(kind,error,where){const typed={kind,stage:stage(where||error?.stage),code:code(error?.code||error?.message)};data.hostFailure=typed;data.errorsTotal++;data.errorsTruncated=data.errorsTotal>8;raw.errors.push(String(error?.stack||error).slice(0,4096));if(raw.errors.length>8)raw.errors.shift();event('failure',typed);}
 async function around(kind,where,body){const at=now();event(kind+'-start',{stage:stage(where)});try{const result=await body();event(kind+'-complete',{stage:stage(where),durationMs:Math.max(0,Math.ceil(now()-at))});return result;}catch(error){failure(kind,error,where);event(kind+'-error',{stage:stage(where),code:code(error?.code||error?.message),detailStage:stage(error?.stage),durationMs:Math.max(0,Math.ceil(now()-at))});throw error;}}
 function stream(which,bytes){if(!['stdout','stderr'].includes(which))return;const chunk=String(bytes);data.streams[which].chars+=chunk.length;data.streams[which].truncated=data.streams[which].chars>16384;raw[which]=(raw[which]+chunk).slice(0,16384);if(which==='stderr'){for(const line of raw.stderr.split(/\r?\n/)){const typed=code(line.trim());if(typed!=='UNCLASSIFIED_ERROR'&&!data.child.stderrCodes.includes(typed)&&data.child.stderrCodes.length<16)data.child.stderrCodes.push(typed);}}flush();}
 function childExit(exitCode,signal){data.child.exitCode=Number.isInteger(exitCode)?exitCode:null;data.child.signal=typeof signal==='string'&&/^SIG[A-Z0-9]{1,16}$/.test(signal)?signal:null;event('child-exit');}
 function complete(generation){data.child.completionSeen=true;event('child-complete',{generation:Number.isSafeInteger(generation)?generation:null});}
 function finish(current){data.current=current;event('finished');}
 event('prepared');return{summary,event,failure,around,stream,childExit,complete,finish,file};
}
module.exports={create,code,stage};
