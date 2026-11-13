'use strict';
// Separate fixed entrypoint. Only its private class credential/config/ticket and
// claims are mounted; no ordinary operator or caller command can select this.
const main=require('./lifecycle-operator-entry').commissionerMain;
if(require.main===module)main().catch(()=>{process.stderr.write('RESTORE_COMMISSION_OUTCOME_UNCERTAIN\n');process.exitCode=1;});
module.exports={main};
