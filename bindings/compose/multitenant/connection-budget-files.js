'use strict';
// Private plan/claim publication only. A stale controller lock refuses; it is
// never erased by a worker or by an arbitrary age-based retry.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=fs.constants,fail=code=>Object.assign(new Error(code),{code});
const need=(v,c)=>{if(!v)throw fail(c);};
function directory(value,create=false){
 need(path.isAbsolute(value)&&!value.split(path.sep).includes('..'),'CONNECTION_BUDGET_PRIVATE_PATH');
 if(create)fs.mkdirSync(value,{recursive:true,mode:0o700});
 let fd=fs.openSync('/',C.O_RDONLY|C.O_DIRECTORY);
 try{for(const part of value.split('/').filter(Boolean)){const n=fs.openSync('/proc/self/fd/'+fd+'/'+part,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);fs.closeSync(fd);fd=n;}
 const s=fs.fstatSync(fd);need([process.getuid(),1000].includes(s.uid)&&!(s.mode&0o077),'CONNECTION_BUDGET_PRIVATE_DIRECTORY');return fd;
 }catch(e){fs.closeSync(fd);throw e;}
}
function location(fd,name){need(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,150}$/.test(name),'CONNECTION_BUDGET_PRIVATE_NAME');return'/proc/self/fd/'+fd+'/'+name;}
function inspect(fd,name){try{const s=fs.lstatSync(location(fd,name));need(s.isFile()&&[process.getuid(),1000].includes(s.uid)&&!(s.mode&0o077)&&s.nlink===1,'CONNECTION_BUDGET_PRIVATE_FILE');return[s.dev,s.ino,s.size,s.mtimeMs];}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function readAt(fd,name){need(inspect(fd,name),'CONNECTION_BUDGET_PRIVATE_FILE');const f=fs.openSync(location(fd,name),C.O_RDONLY|C.O_NOFOLLOW);try{const s=fs.fstatSync(f);need(s.isFile()&&s.size<=1048576&&[process.getuid(),1000].includes(s.uid)&&!(s.mode&0o077),'CONNECTION_BUDGET_PRIVATE_FILE');const raw=fs.readFileSync(f);need(raw.length<=1048576,'CONNECTION_BUDGET_PRIVATE_BOUND');return JSON.parse(raw);}finally{fs.closeSync(f);}}
function read(file){const fd=directory(path.dirname(file));try{return readAt(fd,path.basename(file));}finally{fs.closeSync(fd);}}
function writeAt(fd,name,value,{exclusive=false}={}){const before=inspect(fd,name);need(!exclusive||before===null,'CONNECTION_BUDGET_CLAIM_REUSED');const raw=Buffer.from(JSON.stringify(value)+'\n');need(raw.length<=1048576,'CONNECTION_BUDGET_PRIVATE_BOUND');const temp='tmp-'+crypto.randomBytes(16).toString('hex');const f=fs.openSync(location(fd,temp),C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(f,raw);fs.fsyncSync(f);}finally{fs.closeSync(f);}
 try{need(JSON.stringify(inspect(fd,name))===JSON.stringify(before),'CONNECTION_BUDGET_PRIVATE_CHANGED');if(exclusive){fs.linkSync(location(fd,temp),location(fd,name));fs.unlinkSync(location(fd,temp));}else fs.renameSync(location(fd,temp),location(fd,name));fs.fsyncSync(fd);}finally{try{fs.unlinkSync(location(fd,temp));}catch(e){if(e.code!=='ENOENT')throw e;}}
}
function write(file,value,options){const fd=directory(path.dirname(file));try{writeAt(fd,path.basename(file),value,options);}finally{fs.closeSync(fd);}}
function locked(dir,fn){const fd=directory(dir);let lock;try{lock=fs.openSync(location(fd,'controller.lock'),C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);fs.writeFileSync(lock,String(process.pid));fs.fsyncSync(lock);return fn(fd);}finally{if(lock!==undefined){fs.closeSync(lock);fs.unlinkSync(location(fd,'controller.lock'));fs.fsyncSync(fd);}fs.closeSync(fd);}}
module.exports={directory,readAt,read,writeAt,write,locked,inspect,location};
