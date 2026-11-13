'use strict';
// Per-process mounts preserve the UI/socket-edge authority-document sharing
// while keeping their process tickets and writable claims distinct.
const path=require('node:path');
function render({state,services,serverMaximum=null}){
 if(!Array.isArray(services)||new Set(services).size!==services.length||services.some(x=>['bootstrap','postgres','demo','placement-operator'].includes(x)))throw Error('CONNECTION_BUDGET_SERVICE_ROSTER');
 const root=path.join(state,'connection-budget'),lines=['services:','  bootstrap:','    environment:','      NS_CONNECTION_BUDGET_PROFILE_FILE: /run/ns-budget-profile/profile.json','    volumes:',`      - ${root}/profile.json:/run/ns-budget-profile/profile.json:ro`];
 lines.push('  postgres:');
 if(serverMaximum!==null){if(!Number.isSafeInteger(serverMaximum)||serverMaximum<1||serverMaximum>1000000)throw Error('CONNECTION_BUDGET_SERVER_MAXIMUM');lines.push(`    command: [postgres, -c, wal_level=logical, -c, max_replication_slots=4, -c, max_wal_senders=4, -c, max_slot_wal_keep_size=256MB, -c, max_connections=${serverMaximum}]`);}
 lines.push('    healthcheck:','      test: [CMD, /bin/sh, /run/ns-budget-health/postgres-ready.sh]','    volumes:',`      - ${root}/postgres-ready.sh:/run/ns-budget-health/postgres-ready.sh:ro`);
 for(const service of ['demo','placement-operator'])lines.push('  '+service+':','    environment:','      NS_CONNECTION_BUDGET_UNPLANNED_PROCESS: \"1\"');
 for(const service of services){if(!/^[a-z][a-z0-9-]{0,62}$/.test(service))throw Error('CONNECTION_BUDGET_SERVICE');lines.push('  '+service+':','    environment:','      NS_CONNECTION_BUDGET_FILE: /run/ns-budget/ticket.json','      NS_CONNECTION_BUDGET_PLAN_FILE: /run/ns-budget-plan/plan.json','      NS_CONNECTION_BUDGET_CLAIM_DIR: /run/ns-budget-claims','    volumes:',`      - ${root}/${service}:/run/ns-budget:ro`,`      - ${root}/plan.json:/run/ns-budget-plan/plan.json:ro`,`      - ${root}/${service}/claims:/run/ns-budget-claims:rw`);}
 return lines.join('\n')+'\n';
}
module.exports={render};
