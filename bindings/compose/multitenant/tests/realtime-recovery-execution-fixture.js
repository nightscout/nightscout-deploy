'use strict';
const A=require('../realtime-recovery-action'),J=require('../realtime-recovery-journal'),F=require('../connection-budget-files'),C=require('../control-recovery');
const bytes=v=>Buffer.from(JSON.stringify(v)+'\n');
function execution(f,fd,fresh){
 // Actual common ticket producer/gate and raw admitted file list, no IO effects.
 const config=bytes({synthetic:'config'}),env=bytes({synthetic:'env'});Object.assign(f.context.sealedFiles,{configSha256:A.rawSha(config),environmentSha256:A.rawSha(env)});Object.assign(f.value,f.context.sealedFiles);
 const published=J.publish(fd,fresh.permit,f.value,f.context);J.authorizeStart(fd,published.dispatchPermit,f.plan,f.book,f.context);const view=J.load(fd,f.plan,fresh.row,f.context),actionBytes=A.envelope(view.action).bytes;
 const files={'intent.json':bytes(f.context.intent),'action-binding.json':bytes(view.binding),'host-action.json':actionBytes,'config.json':config,'env.json':env,'before-map.json':f.context.beforeBytes,'before-routes.json':f.context.routesBytes};
 const ticket=C.ticket(f.plan,f.book,fresh.row,f.expected,Object.fromEntries(Object.entries(files).map(([k,v])=>[k,A.rawSha(v)])));
 const actual={...f.expected,cid:'9'.repeat(64),startedAt:'synthetic-control-birth',service:'realtime-recovery'};C.bound(f.plan,f.book,fresh.row,actual,f.expected);F.writeAt(fd,'ledger.json',f.book);const gate=C.gate(f.plan,f.book,fresh.row);
 return{published,view,ticket,gate,files,input:{ticketBytes:bytes(ticket),gateBytes:bytes(gate),files}};
}

module.exports={execution,bytes};
