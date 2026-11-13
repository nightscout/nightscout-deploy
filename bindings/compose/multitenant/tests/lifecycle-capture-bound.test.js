'use strict';
// Bounded source JSON/parser tests. No PostgreSQL, filesystem artifact writes or
// process/heap-capacity claim. Actual core format accepts the oversized control.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const Bound=require('../lifecycle-capture-bound'),IO=require('../lifecycle-artifact-catalogue'),core=require('../../../lib/tenant-lifecycle/artifact'),types=require('pg-types');
const A='11111111-1111-4111-8111-111111111111';
function artifact(){
 const one='x'.repeat(1024*1024);
 return core.buildArtifact({tenant:A,sourceCommit:'a'.repeat(40),exportedAt:1700000000000,catalogues:[{
  kind:'activity',namespace:'synthetic_activity',ledger:[],tables:[{
   table:'activity',columns:[{name:'tenant_id',type:'uuid',identity:false},{name:'doc',type:'jsonb',identity:false}],
   rows:[{tenant_id:A,doc:{identifier:'synthetic-bound',payload:Array(17).fill(one)}}]
  }]
 }]});
}
test('incremental byte counter equals actual UTF8 JSON for supported primitives/escapes/Date/Buffer/nesting and shared values',()=>{const shared={x:'é\ud800\n'},values=[null,true,false,0,-0,1e20,1e21,NaN,Infinity,'"\\\b\f\n\r\t\u0000é☃😀\ud800\udfff',new Date('2026-11-13T00:00:00Z'),new Date(NaN),Buffer.alloc(0),Buffer.from([0,9,10,99,100,255]),[shared,shared],{shared,a:[null,1,{b:'😀'}]},{toJSON:'ordinary JSON field'}];for(const value of values){const size=Buffer.byteLength(JSON.stringify(value));assert.equal(Bound.jsonBytes(value),size);assert.equal(Bound.jsonBytes(value,size),size);assert.throws(()=>Bound.jsonBytes(value,size-1),/LIFECYCLE_ARTIFACT_BOUND/);}const cycle={};cycle.self=cycle;assert.throws(()=>Bound.jsonBytes(cycle),/BOUND/);let getter=false;assert.throws(()=>Bound.jsonBytes({get x(){getter=true;return 'x';}}),/BOUND/);assert.equal(getter,false);assert.throws(()=>Bound.jsonBytes({toJSON(){throw Error('CUSTOM_SERIALIZER');}}),/BOUND/);});
test('valid core artifact over16MiB refuses BEFORE bulk artifact serializer or any output-directory access',async()=>{const value=artifact();core.validateArtifact(value);const stringify=JSON.stringify,open=fs.openSync;let bulk=false,directory=false,code;try{JSON.stringify=function(object,...args){if(object===value){bulk=true;throw Object.assign(Error('BULK_SERIALIZER_BEFORE_BOUND'),{code:'BULK_SERIALIZER_BEFORE_BOUND'});}return stringify(object,...args);};fs.openSync=()=>{directory=true;throw Error('OUTPUT_DIRECTORY_BEFORE_BOUND');};try{await IO.saveCapture(value,'/not-accessed');}catch(error){code=error.code;}}finally{JSON.stringify=stringify;fs.openSync=open;}assert.equal(code,'LIFECYCLE_ARTIFACT_BOUND','OVERSIZED_CAPTURE_MUST_REFUSE_BEFORE_BULK_SERIALIZER');assert.equal(bulk,false);assert.equal(directory,false);});
test('counter omission is red against original bulk-serializer discriminator, restored rejects before serializer',async()=>{const file=require.resolve('../lifecycle-artifact-catalogue'),source=fs.readFileSync(file,'utf8'),from=" require('./lifecycle-capture-bound').jsonBytes(artifact,LIMIT-1);",changed=source.replace(from,' JSON.stringify(artifact);');assert.notEqual(source,changed);const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(changed,file);const value=artifact(),stringify=JSON.stringify;try{JSON.stringify=function(object,...args){if(object===value)throw Object.assign(Error('BULK_SERIALIZER_BEFORE_BOUND'),{code:'BULK_SERIALIZER_BEFORE_BOUND'});return stringify(object,...args);};await assert.rejects(m.exports.saveCapture(value,'/not-accessed'),{code:'BULK_SERIALIZER_BEFORE_BOUND'});await assert.rejects(IO.saveCapture(value,'/not-accessed'),{code:'LIFECYCLE_ARTIFACT_BOUND'});}finally{JSON.stringify=stringify;}});
test('actual installed pg expanding parsers remain below conservative6x leaf/row JSON qualification on discriminator corpus',()=>{
 const cases=[[17,'\\x','"\\\\x"'],[17,'\\x00ff1020','"\\\\x00ff1020"'],[20,'9223372036854775807','9223372036854775807'],[1700,'0.00000000000000001','0.00000000000000001'],[701,'100000000000000000000','1e20'],[1082,'0001-01-01','"0001-01-01"'],[1184,'2026-11-13 00:00:00+00','"2026-11-13T00:00:00+00:00"'],[3802,'{"n":1e20,"unicode":"😀"}','{"n":1e20,"unicode":"😀"}'],[1009,'[2147483647:2147483647]={x}','["x"]'],[1016,'{9223372036854775807,1}','[9223372036854775807,1]']];
 for(const [oid,text,pgJson]of cases){assert(require('../lifecycle-capture-preflight').TYPES.includes(oid));const parsed=types.getTypeParser(oid,'text')(text),actual=Bound.jsonBytes(parsed);assert(actual<=6*Buffer.byteLength(pgJson),oid+' DEFAULT_PARSER_QUALIFICATION');}
 // Unknown/unregistered array representations and custom type/cast semantics
 // are deliberately outside this finite proof; metadata must reject them.
 assert(!require('../lifecycle-capture-preflight').TYPES.includes(1003));assert(!require('../lifecycle-capture-preflight').TYPES.includes(1186));
});
