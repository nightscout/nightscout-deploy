'use strict';
// One fresh process per private operator lease, matching the actual entry lifetime.
const fs=require('node:fs');
Promise.resolve().then(async()=>{
 const payload=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 const config=require('../restore').validateRecoveryConfig(payload.config,process.env);
 return require('../lifecycle-operator-entry').execute({ticket:payload.ticket,gate:payload.gate,config,env:process.env,admission:require('../../../lib/storage/connection-admission'),pg:require('pg')});
}).then(receipt=>process.stdout.write(JSON.stringify(receipt)+'\n'),error=>{process.stderr.write(JSON.stringify({error:error.code||'NATIVE_BIND_RECOVERY_REFUSED'})+'\n');process.exitCode=1;});
