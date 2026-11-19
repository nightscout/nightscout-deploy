'use strict';
// Bounded private read only; never installs admission or constructs PG clients.
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.NS_ENV_FILE || '/run/ns-config/env.json';
const reader = path.join(__dirname, '../../lib/server/serve/config-file.js');
const coreBound = fs.existsSync(reader);
function limit () {
  if (!coreBound) return 1048576;
  try { return require(reader).maxBytes(process.env); } catch (error) {
    // The code and range are not secret; the value set is the operator's own.
    process.stderr.write('Private service environment bound is invalid (' + (error?.code === 'CONFIG_FILE_LIMIT_INVALID' ? error.code : 'CONFIG_FILE_READER_FAILED') + ')\n');
    process.exit(78);
  }
}
const maxBytes = limit();
function read () {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let values;
  try {
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o077))throw new Error();
    if(stat.size>maxBytes){
      process.stderr.write('Private service environment is too large (CONFIG_FILE_TOO_LARGE: '+stat.size+' bytes, over the limit of '+maxBytes+' bytes, '+(coreBound?'MULTITENANT_CONFIG_MAX_BYTES':'fixed: this core has no configurable bound')+')\n');process.exit(78);
    }
    const bytes=Buffer.alloc(stat.size+1);let used=0;
    while(used<bytes.length){const count=fs.readSync(fd,bytes,used,bytes.length-used,null);if(!count)break;used+=count;}
    const after=fs.fstatSync(fd);if(used!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw new Error();
    values=JSON.parse(bytes.subarray(0,used));
  }finally{fs.closeSync(fd);}
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error();
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0') ||
        (['NODE_OPTIONS', 'NODE_PATH', 'PATH', 'LD_PRELOAD', 'NS_ENV_FILE', 'MULTITENANT_CONFIG_MAX_BYTES'].includes(key))) throw new Error();
  }
  return values;
}
function apply () {try{const values=read();Object.assign(process.env,values);return values;}catch{process.stderr.write('Private service environment is missing or invalid\n');process.exit(78);}}
module.exports={read,apply};
