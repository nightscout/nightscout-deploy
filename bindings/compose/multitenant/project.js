'use strict';
// Prepared identity wins over ambient COMPOSE_PROJECT_NAME/NS_DEMO_PROJECT.
const fs=require('node:fs'),path=require('node:path');
const DEFAULT='nightscout-multitenant-demo';
function validate(value){if(typeof value!=='string'||!/^[a-z][a-z0-9-]{0,62}$/.test(value))throw Object.assign(new Error('COMPOSE_PROJECT_INVALID'),{code:'COMPOSE_PROJECT_INVALID'});return value;}
function read(directory){
 let fd;try{fd=fs.openSync(path.join(directory,'.env'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}catch(e){if(e.code==='ENOENT')return DEFAULT;throw e;}
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>16384)throw Error('COMPOSE_PROJECT_ENV_INVALID');const bytes=Buffer.alloc(16385),length=fs.readSync(fd,bytes,0,bytes.length,0);if(length>16384)throw Error('COMPOSE_PROJECT_ENV_INVALID');const lines=bytes.subarray(0,length).toString('utf8').split('\n').filter(x=>x.startsWith('NS_DEMO_PROJECT='));if(lines.length>1)throw Error('COMPOSE_PROJECT_ENV_INVALID');return lines.length?validate(lines[0].slice('NS_DEMO_PROJECT='.length)):DEFAULT;}finally{fs.closeSync(fd);}
}
module.exports={DEFAULT,validate,read};
if(require.main===module){try{process.stdout.write(read(__dirname));}catch{process.stderr.write('COMPOSE_PROJECT_INVALID\n');process.exitCode=1;}}
