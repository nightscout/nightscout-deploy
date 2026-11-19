'use strict';
// Bounded private read only; never installs admission or constructs PG clients.
const fs = require('node:fs');
const file = process.env.NS_ENV_FILE || '/run/ns-config/env.json';
// Fixed bound: the largest measured role document is 3.8 KB at 10,000 tenants.
const maxBytes = 1048576;
function read () {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let values;
  try {
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o077))throw new Error();
    if(stat.size>maxBytes){
      process.stderr.write('Private service environment is too large (CONFIG_FILE_TOO_LARGE: '+stat.size+' bytes, over the limit of '+maxBytes+' bytes)\n');process.exit(78);
    }
    const bytes=Buffer.alloc(stat.size+1);let used=0;
    while(used<bytes.length){const count=fs.readSync(fd,bytes,used,bytes.length-used,null);if(!count)break;used+=count;}
    const after=fs.fstatSync(fd);if(used!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw new Error();
    values=JSON.parse(bytes.subarray(0,used));
  }finally{fs.closeSync(fd);}
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error();
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0') ||
        (['NODE_OPTIONS', 'NODE_PATH', 'PATH', 'LD_PRELOAD', 'NS_ENV_FILE'].includes(key))) throw new Error();
  }
  return values;
}
function apply () {try{const values=read();Object.assign(process.env,values);return values;}catch{process.stderr.write('Private service environment is missing or invalid\n');process.exit(78);}}
module.exports={read,apply};
