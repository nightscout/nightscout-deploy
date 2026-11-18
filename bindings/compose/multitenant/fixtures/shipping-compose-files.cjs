'use strict';
// Test-only composition from prepared selections, never ambient environment.
const fs=require('node:fs'),path=require('node:path');
const fail=()=>{throw new Error('SHIPPING_COMPOSE_SELECTION_REFUSED');};
function files({core,state}){
 const folder=path.join(core,'deploy/multitenant'),environment=new Map();
 for(const line of fs.readFileSync(path.join(folder,'.env'),'utf8').trim().split('\n')){
  const at=line.indexOf('=');if(at<1||environment.has(line.slice(0,at)))fail();environment.set(line.slice(0,at),line.slice(at+1));
 }
 if(path.resolve(environment.get('NS_DEMO_STATE')||'.')!==path.resolve(state))fail();
 const count=(key,max)=>{const value=environment.get(key);if(!/^[1-9][0-9]*$/.test(value||'')||Number(value)>max)fail();return Number(value);};
 count('NS_API_REPLICAS',16);
 const source=Object.fromEntries(environment);
 const realtime=require('../realtime-workers').selection(source);
 const evaluator=require('../evaluator-workers').selection(source);
 const selected=['compose.replicas.yaml',...(realtime?['compose.realtime.yaml']:[]),...(evaluator?['compose.evaluator.yaml']:[])];
 const present=fs.readdirSync(state).filter(name=>/^compose\..*\.ya?ml$/.test(name));
 if(present.length!==selected.length||present.some(name=>!selected.includes(name)))fail();
 for(const name of selected){const stat=fs.lstatSync(path.join(state,name));if(!stat.isFile()||stat.isSymbolicLink())fail();}
 return [path.join(folder,'compose.yaml'),...selected.map(name=>path.join(state,name))];
}
module.exports={files};
