'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('selected restore commissioning refuses before config read or PG constructor',async()=>{
 const before=process.env.NS_CONNECTION_BUDGET_PROFILE_FILE;process.env.NS_CONNECTION_BUDGET_PROFILE_FILE='/private/selected-profile';
 try{await assert.rejects(require('../commission-restore').commission({}),/CONNECTION_BUDGET_UNPLANNED_PROCESS/);}finally{if(before===undefined)delete process.env.NS_CONNECTION_BUDGET_PROFILE_FILE;else process.env.NS_CONNECTION_BUDGET_PROFILE_FILE=before;}
 const overlay=require('../connection-budget-compose').render({state:'/private/synthetic',services:['api']});for(const service of ['demo','placement-operator'])assert(overlay.includes('  '+service+':\n    environment:\n      NS_CONNECTION_BUDGET_UNPLANNED_PROCESS: "1"'));
});
