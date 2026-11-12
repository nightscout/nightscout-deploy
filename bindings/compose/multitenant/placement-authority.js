'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const fail=()=>{throw Object.assign(new Error('PLACEMENT_AUTHORITY_REFUSED'),{code:'PLACEMENT_AUTHORITY_REFUSED'});};
function read(file,sourceCommit){
 if(typeof file!=='string'||!path.isAbsolute(file))fail();
 let stat;try{stat=fs.lstatSync(file);}catch{fail();}if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.size>16384)fail();
 const bytes=fs.readFileSync(file);let values;try{values=JSON.parse(bytes);}catch{fail();}
 const keys=['NS_PLACEMENT_PG','NS_ACTIVITY_PG','NS_SOURCE_COMMIT','MULTITENANT_REALTIME_PLACEMENT'];
 if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).length!==keys.length||keys.some(key=>typeof values[key]!=='string'||!values[key]||values[key].includes('\0'))||values.NS_SOURCE_COMMIT!==sourceCommit||values.MULTITENANT_REALTIME_PLACEMENT!=='/run/ns-placement/backend.json')fail();
 for(const key of ['NS_PLACEMENT_PG','NS_ACTIVITY_PG']){let value;try{value=new URL(values[key]);}catch{fail();}if(!['postgres:','postgresql:'].includes(value.protocol)||!value.username||!value.password||!value.hostname||!value.pathname.slice(1)||value.hash)fail();}
 return Object.freeze({path:file,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),values:Object.freeze(values)});
}
function verify(file,sourceCommit,digest){if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))fail();const value=read(file,sourceCommit);if(value.sha256!==digest)fail();return value;}
module.exports={read,verify};
