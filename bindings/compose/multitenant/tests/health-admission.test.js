'use strict';
// Actual role loader and environment source with a recording CLI only.
// No Docker, network connection, SQL, service or PG connect is performed.
// Each role's pool sizes bound its PostgreSQL connections (census C-06); the
// loader installs no per-process connection plan.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const F=require('../connection-budget-files');
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-health-admission-'));fs.chmodSync(dir,0o700);const base=path.join(dir,'deploy/multitenant');fs.mkdirSync(base,{recursive:true});
 for(const name of ['entrypoint.js','load-env.js','service-environment.js'])fs.copyFileSync(path.join(__dirname,'..',name),path.join(base,name));
 F.write(path.join(dir,'env.json'),{NS_API_PG:'private-environment-sentinel'});
 const preload=path.join(dir,'recording.cjs');fs.writeFileSync(preload,`const M=require('node:module'),fs=require('node:fs'),assert=require('node:assert/strict'),load=M._load;M._load=function(name,...args){if(name==='../../lib/cli')return{main(){assert.equal(process.env.NS_API_PG,'private-environment-sentinel');fs.writeFileSync(${JSON.stringify(path.join(dir,'role-main'))},'started');}};if(name==='pg')throw Error('LOADER_MUST_NOT_CONSTRUCT_PG');return load.call(this,name,...args);};`);
 const env={...process.env,NS_ENV_FILE:path.join(dir,'env.json')};delete env.NS_API_PG;
 function run(args){return spawnSync(process.execPath,['-r',preload,...args],{env,encoding:'utf8',timeout:5000,maxBuffer:16384});}
 return{dir,base,run,close(){fs.rmSync(dir,{recursive:true});}};
}
test('actual entrypoint applies the private environment and starts the role without a connection plan',()=>{const f=fixture();try{
 const first=f.run([path.join(f.base,'entrypoint.js'),'api']);assert.equal(first.status,0,first.stderr);assert.equal(fs.readFileSync(path.join(f.dir,'role-main'),'utf8'),'started');
 }finally{f.close();}});
test('private environment preload injection is refused by the mandatory role loader',()=>{const f=fixture();try{
 F.write(path.join(f.dir,'env.json'),{NODE_OPTIONS:'--require forbidden-preload'});
 const result=f.run([path.join(f.base,'entrypoint.js'),'api']);assert.equal(result.status,78);assert(!fs.existsSync(path.join(f.dir,'role-main')));
 }finally{f.close();}});
module.exports={fixture};
