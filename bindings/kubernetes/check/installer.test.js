'use strict';
// Exercise the rendered installer against symlinked Secret-like input, then the actual
// source environment reader. This checks the discovered token-loss/admin-address failures.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
test('rendered installer copies token files as private regular files and adapts the loaded admin address',()=>{
  const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ns-k8s-installer-'));
  try{
    const rendered=JSON.parse(execFileSync('tk',['eval','environments/synthetic'],{cwd:root,encoding:'utf8'}));
    const init=rendered.admin.deployment.spec.template.spec.initContainers.find(c=>c.name==='install-config');
    fs.mkdirSync(tmp+'/secret/admin/.data',{recursive:true});
    for(const [name,bytes] of Object.entries({'env.json':JSON.stringify({ADMIN_HOSTNAME:'admin',ADMIN_PORT:'1342'}),'vault-token':'fixture-bytes','management-vault-token':'second-fixture'})){
      fs.writeFileSync(tmp+'/secret/admin/.data/'+name,bytes);fs.symlinkSync('.data/'+name,tmp+'/secret/admin/'+name);
    }
    fs.mkdirSync(tmp+'/secret/admin/verification');
    fs.writeFileSync(tmp+'/secret/admin/.data/api.operation.json', 'synthetic-private-target');
    fs.symlinkSync('../.data/api.operation.json',tmp+'/secret/admin/verification/api.operation.json');
    const script=init.command[2].replaceAll('/run/ns-secret',tmp+'/secret').replaceAll('/run/ns-config',tmp+'/config').replaceAll('/run/ns-ipc-volume',tmp+'/ipc');
    execFileSync('node',['-e',script,'admin'],{env:{...process.env,NS_BIND_ADMIN_ADDRESS:'192.0.2.10'}});
    const dir=tmp+'/config/admin/d';
    for(const name of ['env.json','vault-token','management-vault-token','verification/api.operation.json']){
      const stat=fs.lstatSync(dir+'/'+name);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.mode&0o777,0o400);
    }
    assert.equal(fs.statSync(dir+'/verification').mode&0o777,0o700);
    assert.equal(fs.statSync(dir).mode&0o777,0o700);
    const source=path.join(root,'assets/service-environment.js');
    const actual=execFileSync('node',['-e',`require(${JSON.stringify(source)}).apply();process.stdout.write(process.env.ADMIN_HOSTNAME)`],{env:{...process.env,NS_ENV_FILE:dir+'/env.json'},encoding:'utf8'});
    assert.equal(actual,'192.0.2.10');
    fs.chmodSync(dir+'/env.json',0o440);
    const denied=require('node:child_process').spawnSync('node',['-e',`require(${JSON.stringify(source)}).apply()`],{env:{...process.env,NS_ENV_FILE:dir+'/env.json'},encoding:'utf8'});
    assert.equal(denied.status,78);assert.match(denied.stderr,/Private service environment is missing or invalid/);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
