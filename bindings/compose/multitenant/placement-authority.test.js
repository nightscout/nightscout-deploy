'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const authority=require('./placement-authority');
test('publisher authority is exact readonly-custody shape with pinned source and no unused serving/operator credentials',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-pub-auth-')),file=path.join(dir,'env.json'),source='a'.repeat(40);
 const value={NS_PLACEMENT_PG:'postgres://publisher:synthetic@postgres/example',NS_ACTIVITY_PG:'postgres://activity:synthetic@postgres/example',NS_SOURCE_COMMIT:source,MULTITENANT_REALTIME_PLACEMENT:'/run/ns-placement/backend.json'};
 const write=v=>fs.writeFileSync(file,JSON.stringify(v),{mode:0o600});
 try{
  write(value);const first=authority.read(file,source);assert.match(first.sha256,/^[a-f0-9]{64}$/);assert.equal(first.values.NS_OPERATOR_PG,undefined);
  assert.equal(authority.verify(file,source,first.sha256).sha256,first.sha256);
  for(const digest of [undefined,'0'.repeat(64)])assert.throws(()=>authority.verify(file,source,digest),{code:'PLACEMENT_AUTHORITY_REFUSED'});
  for(const key of ['NS_OPERATOR_PG','NS_REALTIME_PG','VAULT_TOKEN']){write({...value,[key]:'forbidden-unused-custody'});assert.throws(()=>authority.read(file,source),{code:'PLACEMENT_AUTHORITY_REFUSED'});}
  write({...value,NS_SOURCE_COMMIT:'b'.repeat(40)});assert.throws(()=>authority.read(file,source),{code:'PLACEMENT_AUTHORITY_REFUSED'});
  const absent={...value};delete absent.NS_PLACEMENT_PG;write(absent);assert.throws(()=>authority.read(file,source),{code:'PLACEMENT_AUTHORITY_REFUSED'});
  write(value);fs.chmodSync(file,0o644);assert.throws(()=>authority.read(file,source),{code:'PLACEMENT_AUTHORITY_REFUSED'});fs.chmodSync(file,0o600);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('private publisher never adopts an operator fallback or reaches SQL without explicit narrow connection',async()=>{
 await assert.rejects(require('./placement-control').run({candidate:{},timeoutMs:1000,source:{NS_OPERATOR_PG:'postgres://operator:synthetic@postgres/example'}}),{code:'PLACEMENT_OPERATOR_INPUT_REQUIRED'});
});
