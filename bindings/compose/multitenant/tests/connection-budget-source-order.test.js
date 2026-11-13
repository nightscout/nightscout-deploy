'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('selected preparation rejects dirty/unreviewed source before source-dependent configuration modules or effects',()=>{
 for(const mode of ['dirty','unreviewed']){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-budget-source-order-')),state=path.join(dir,'absent'),seen=[],load=Module._load;
 Module._load=function(name,...args){if(name==='node:os')return{...os,networkInterfaces:()=>({lo:[{address:'127.0.0.1'}]})};if(name==='./build')return{assertCleanSource(){seen.push('source-admission');if(mode==='dirty')throw Error('DIRTY_SOURCE_CONTROL');return'0'.repeat(40);},overlay(){return{deployCommit:'a'.repeat(40)};}};if(['./replicas','./realtime-workers','./evaluator-workers','./registry-plan'].includes(name))seen.push(name);return load.call(this,name,...args);};
 try{const prepare=require('../prepare').prepare;assert.throws(()=>prepare(['--state',state,'--connection-budget',path.join(dir,'private-profile.json')]),mode==='dirty'?/DIRTY_SOURCE_CONTROL/:/UNREVIEWED_SOURCE/);assert.deepEqual(seen,['source-admission']);assert(!fs.existsSync(state));}finally{Module._load=load;fs.rmSync(dir,{recursive:true});}
 }
});
