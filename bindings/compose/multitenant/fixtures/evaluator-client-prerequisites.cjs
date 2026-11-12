'use strict';
// Explicit read-only pre-mutation observation, never clinical qualification.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),diagnostics=require('./evaluator-client-diagnostics.cjs');
async function main(){
 const [core,state,rawPort,...extra]=process.argv.slice(2),port=Number(rawPort);
 if(extra.length||!path.isAbsolute(core||'')||!path.isAbsolute(state||'')||!Number.isInteger(port)||port<1024||port>65535)throw new Error('CLIENT_PREREQUISITE_ARGUMENTS_REFUSED');
 const tenants=JSON.parse(fs.readFileSync(path.join(state,'primer/tenants.json'))).tenants,roots=JSON.parse(fs.readFileSync(path.join(state,'primer/provisioned.json')));if(tenants.length!==2)throw new Error('CLIENT_PREREQUISITE_TENANTS_REFUSED');
 const {io}=require(path.join(core,'node_modules/socket.io-client')),clients=[],agents=[],start=performance.now();
 try{
  for(const [index,namespace]of[[0,'/alarm'],[1,'/alarm'],[1,'/']]){
   const tenant=tenants[index],agent=new http.Agent({keepAlive:true,lookup:(host,options,done)=>options.all?done(null,[{address:'127.0.0.1',family:4}]):done(null,'127.0.0.1',4)});agents.push(agent);
   clients.push(diagnostics.connect({io,origin:'http://'+tenant.host+':'+port,namespace,agent,name:(index?'B':'A')+namespace,accessToken:tenant.dataToken,secret:namespace==='/'?crypto.createHash('sha1').update(roots.find(row=>row.id===tenant.id).rootSecret).digest('hex'):undefined}));
  }
  const deadline=performance.now()+20000;while(performance.now()<deadline&&!diagnostics.prerequisites(...clients))await new Promise(resolve=>setTimeout(resolve,50));
  const passed=diagnostics.prerequisites(...clients);console.log(JSON.stringify({scope:'read-only pre-mutation prerequisites; not clinical qualification',passed,elapsedMs:Math.ceil(performance.now()-start),deadlineMs:20000,clients:clients.map(diagnostics.summary)}));if(!passed)process.exitCode=1;
 }finally{for(const client of clients){client.socket.io.reconnection(false);client.socket.disconnect();}await new Promise(resolve=>setTimeout(resolve,200));for(const agent of agents)agent.destroy();}
}
main().catch(()=>{console.error(JSON.stringify({code:'CLIENT_PREREQUISITE_OBSERVATION_REFUSED'}));process.exitCode=1;});
